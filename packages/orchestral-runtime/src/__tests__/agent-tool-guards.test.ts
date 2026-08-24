// Regression suite for dispatchAgent's runtime tool-call guards:
// SUBAGENT_TOOL_OUT_OF_SCOPE (allowlist), CIRCULAR_AGENT_TOOL (ancestor
// cycle) and SUBAGENT_BLOCKED (default sub-agent blocklist), plus the
// `job:tool-rejected` event all three fan out. They live inside
// `dispatchAgent`'s `onToolCall` (agent-dispatch.ts) and the first two are
// *security* invariants, not ergonomics:
//
//   • Scope. With two-stage discovery the LLM only ever sees `find_pattern` +
//     `dispatch_pattern`, so the tool catalog cannot express "you may not call
//     X" — a hallucinating or adversarial loop can name ANY registered pattern
//     id. `loop.toolPatternIds` is therefore enforced at dispatch time, not
//     just at catalog-build time. If that check silently stops firing, an agent
//     can invoke every Pattern in the host's registry, including ones that cost
//     money or touch data it was never scoped to.
//   • Cycles. `visited` (ancestor chain, seeded in `_submitJobInternal` as
//     ancestors ∪ {self}) is the only thing standing between a loop and
//     unbounded recursion through a pattern that is already on its own dispatch
//     chain. `maxAgentDepth` does NOT cover this: `countAgentAncestors` counts
//     only `kind === 'agent'` ancestors, so an agent → meta → agent → meta …
//     ring can spin without ever raising the agent-ancestor count past the cap.
//
// Both guards fail *open* if broken — the dispatch simply succeeds — which is
// exactly the shape of failure no other test in the suite would notice. Hence
// the paired positive controls below: every rejection test has a sibling that
// proves the same harness lets a legitimate call through, so a guard stuck in
// "reject everything" is caught too.
//
// Harness mirrors agent-inline-core-dispatch.test.ts: a real InlineRuntime over
// an in-memory JobStore, a router whose fake model echoes a text output, and a
// scripted fake AgentRunImpl that drives `onToolCall` directly and records what
// came back.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AtomicPattern,
  CapabilityRouter,
  ExecutionContext,
  JobEvent,
  MetaPattern,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { silentDiagnosticsLogger, InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'
import type { AgentRunImpl } from '../agent-run'

// Router resolving every capability to one fake model whose call echoes a typed
// text output. `calls` tallies real model invocations — that is how the tests
// below distinguish "the guard rejected before dispatch" from "the dispatch ran
// and the guard merely relabelled the result".
function makeRouter(calls: { count: number }): CapabilityRouter {
  const cap = {
    modelId: 'fake:m',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      calls.count++
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })
const PROMPT_INPUT = z.object({ prompt: z.string() })

// A plain dispatchable atomic. Left on the default exposure ('tool' → visible
// to both chat-turn and agent-loop) on purpose: a pattern rejected by the
// allowlist guard must be one that `resolveDispatchTarget` would otherwise have
// happily resolved, otherwise the test would be proving the exposure gate.
function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    outputs: TEXT_OUTPUT,
    primary: { tool: { description: `run ${id}`, inputs: PROMPT_INPUT } },
  } as unknown as AtomicPattern
}

// A meta that forwards its input to one child via ctx.step. Used as the "B" hop
// in the A → B → A cycle: an agent can legitimately dispatch a meta (no
// blocklist prefix), and a meta can legitimately step into an agent — so a ring
// closes through meta without ever tripping DEFAULT_SUBAGENT_BLOCKLIST.
function hopMeta(id: string, childPatternId: string): MetaPattern {
  return {
    id,
    kind: 'meta',
    description: `meta forwarding to ${childPatternId}`,
    tool: { description: id, inputs: PROMPT_INPUT },
    outputs: z.object({ done: z.boolean() }),
    async compose(args: { input: unknown }, ctx: ExecutionContext) {
      // Return what the schema above promises, not the child's output: the
      // runtime holds a meta to its declared `outputs` at the dispatch exit.
      await ctx.step({
        patternId: childPatternId,
        input: { prompt: (args.input as { prompt?: string }).prompt ?? 'x' },
      })
      return { done: true }
    },
  } as unknown as MetaPattern
}

// Default-finish agent (registration backfills finish + outputs).
function agent(
  id: string,
  toolPatternIds: readonly string[],
  extra: Record<string, unknown> = {},
): AgentPattern {
  return {
    id,
    kind: 'agent',
    description: `agent ${id}`,
    primary: { tool: { description: 'run', inputs: PROMPT_INPUT } },
    loop: { system: 'sys', toolPatternIds, modelTags: [] },
    ...extra,
  } as unknown as AgentPattern
}

interface ToolStep {
  name: string
  input: unknown
  callId: string
}

/**
 * Fake AgentRunImpl driven by a per-pattern script. Every scripted tool result
 * is pushed onto `results` keyed by the calling agent's patternId, so a test
 * spanning several agents can assert on the exact loop it cares about. Each
 * loop always ends with a valid finish so the job completes cleanly and the
 * assertions are about the guard, not about AGENT_INCOMPLETE.
 */
function makeRunImpl(
  scripts: Record<string, ToolStep[]>,
  results: Record<string, unknown[]>,
): AgentRunImpl {
  return {
    async run(args) {
      const script = scripts[args.patternId] ?? []
      for (const step of script) {
        const res = await args.onToolCall({
          name: step.name,
          input: step.input,
          callId: step.callId,
        })
        const bucket = results[args.patternId] ?? []
        bucket.push(res)
        results[args.patternId] = bucket
      }
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      return { text: 'done' }
    },
  }
}

interface Harness {
  runtime: InlineRuntime
  store: MemoryJobStore
  results: Record<string, unknown[]>
  calls: { count: number }
  /**
   * Every JobEvent the runtime fanned out, across every job in the dispatch
   * tree, in emission order. Subscription happens in the `onJobCreated` init
   * hook because `submitJob` only resolves once the job is terminal — a
   * post-hoc `subscribe` would observe nothing. Collected tree-wide on
   * purpose: a rejection fires on the stream of the agent that made the call,
   * which for a nested agent is a child job, not the root.
   */
  events: JobEvent[]
  /** id of the first job the store ever saw — i.e. the root submitJob. */
  rootJobId(): string
}

function makeHarness(opts: {
  patterns: readonly (AtomicPattern | MetaPattern | AgentPattern)[]
  scripts: Record<string, ToolStep[]>
  maxAgentDepth?: number
}): Harness {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of opts.patterns) registry.register(p as never)
  const results: Record<string, unknown[]> = {}
  const calls = { count: 0 }
  const store = new MemoryJobStore()
  let firstJobId: string | undefined
  store.subscribe((ev) => {
    firstJobId ??= ev.job.id
  })
  const events: JobEvent[] = []
  const runtime: InlineRuntime = new InlineRuntime({
    store: store as never,
    registry,
    router: makeRouter(calls),
    agentRunImpl: makeRunImpl(opts.scripts, results),
    onJobCreated: (jobId) => {
      runtime.subscribe(jobId, (ev) => events.push(ev))
    },
    ...(opts.maxAgentDepth !== undefined ? { maxAgentDepth: opts.maxAgentDepth } : {}),
  })
  return {
    runtime,
    store,
    results,
    calls,
    events,
    rootJobId: () => firstJobId as string,
  }
}

/** The `job:tool-rejected` events collected by a harness, in emission order. */
function rejections(h: Harness): Extract<JobEvent, { type: 'job:tool-rejected' }>[] {
  return h.events.filter((e) => e.type === 'job:tool-rejected')
}

/**
 * Index of the terminal event for `jobId` within the tree-wide event log.
 * Used to pin that a rejection reaches a subscriber while the job is still
 * running — an event delivered after the job settles is one a host filtering
 * on live jobs would never see, and one a replay would order wrongly.
 */
function terminalIndex(h: Harness, jobId: string): number {
  return h.events.findIndex(
    (e) =>
      e.job.id === jobId &&
      (e.type === 'job:completed' ||
        e.type === 'job:failed' ||
        e.type === 'job:cancelled'),
  )
}

/** Shorthand for the tool call an LLM emits to invoke a Pattern. */
function dispatchStep(patternId: string, prompt: string, callId: string): ToolStep {
  return {
    name: 'dispatch_pattern',
    input: { pattern_id: patternId, input: { prompt } },
    callId,
  }
}

/** The structured tool-result shape both guards return. */
interface GuardVerdict {
  code?: string
  pattern_id?: string
  caller_pattern_id?: string
  allowlist?: readonly string[]
  ancestors?: readonly string[]
  message?: string
  hint?: string
}

// ── SUBAGENT_TOOL_OUT_OF_SCOPE ─────────────────────────────────────────────
//
// `loop.toolPatternIds` is a hard dispatch gate, not a catalog-shaping hint.
describe('SUBAGENT_TOOL_OUT_OF_SCOPE', () => {
  it('rejects a registered, agent-loop-visible pattern outside loop.toolPatternIds', async () => {
    const h = makeHarness({
      patterns: [
        atomic('allowed_atomic'),
        atomic('forbidden_atomic'),
        agent('agent_scoped', ['allowed_atomic']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('forbidden_atomic', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const verdict = h.results.agent_scoped?.[0] as GuardVerdict
    expect(verdict.code).toBe('SUBAGENT_TOOL_OUT_OF_SCOPE')
    // The rejected id has to be nameable by the model — otherwise it cannot
    // tell which of its calls was refused.
    expect(verdict.pattern_id).toBe('forbidden_atomic')
    expect(verdict.message).toContain('forbidden_atomic')
    expect(verdict.caller_pattern_id).toBe('agent_scoped')
    expect(verdict.allowlist).toEqual(['allowed_atomic'])
    // Rejected BEFORE the child was submitted — a guard that ran the dispatch
    // and only then complained would still have paid for the model call.
    expect(h.calls.count).toBe(0)
  })

  it('lets an allowlisted pattern through (positive control)', async () => {
    const h = makeHarness({
      patterns: [
        atomic('allowed_atomic'),
        atomic('forbidden_atomic'),
        agent('agent_scoped', ['allowed_atomic']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('allowed_atomic', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    // The atomic's typed output comes back — no guard code anywhere in sight.
    expect(h.results.agent_scoped?.[0]).toEqual({ modality: 'text', text: 'ok' })
    expect(h.calls.count).toBe(1)
  })

  it('honours the async intersection: in toolPatternIds but not asyncToolPatternIds is out of scope', async () => {
    // An async agent's effective allowlist is toolPatternIds ∩
    // asyncToolPatternIds. The guard reads the *effective* list, so a pattern
    // the author declared for sync use only must not slip through here.
    const h = makeHarness({
      patterns: [
        atomic('async_ok'),
        atomic('sync_only'),
        agent('agent_async', ['async_ok', 'sync_only'], {
          defaultExecutionMode: 'async',
          loop: {
            system: 'sys',
            toolPatternIds: ['async_ok', 'sync_only'],
            asyncToolPatternIds: ['async_ok'],
            modelTags: [],
          },
        }),
      ],
      scripts: {
        agent_async: [
          dispatchStep('sync_only', 'nope', 'tc-1'),
          dispatchStep('async_ok', 'yes', 'tc-2'),
        ],
      },
    })
    await h.runtime.submitJob({ patternId: 'agent_async', input: { prompt: 'start' } })

    const rejected = h.results.agent_async?.[0] as GuardVerdict
    expect(rejected.code).toBe('SUBAGENT_TOOL_OUT_OF_SCOPE')
    expect(rejected.pattern_id).toBe('sync_only')
    // The reported allowlist is the narrowed one, not the raw toolPatternIds —
    // a model told "[async_ok, sync_only]" would just retry the same call.
    expect(rejected.allowlist).toEqual(['async_ok'])
    // Control: the intersection member still dispatches.
    expect(h.results.agent_async?.[1]).toEqual({ modality: 'text', text: 'ok' })
    expect(h.calls.count).toBe(1)
  })
})

// ── CIRCULAR_AGENT_TOOL ────────────────────────────────────────────────────
//
// The check is `visited.has(resolvedPatternId)` — an ANCESTOR test, evaluated
// against the chain that reached this agent. The two negative cases below are
// the ones that matter: "already dispatched once" is not the same thing as
// "on my ancestor chain", and conflating them would break every legitimate
// fan-out.
describe('CIRCULAR_AGENT_TOOL', () => {
  it('rejects A → A (an agent dispatching itself)', async () => {
    const h = makeHarness({
      patterns: [agent('agent_selfloop', ['agent_selfloop'])],
      scripts: {
        agent_selfloop: [dispatchStep('agent_selfloop', 'again', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_selfloop',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const verdict = h.results.agent_selfloop?.[0] as GuardVerdict
    // Ordering matters: the cycle check runs BEFORE the allowlist and blocklist
    // checks, so a self-dispatch reports the cycle rather than SUBAGENT_BLOCKED.
    expect(verdict.code).toBe('CIRCULAR_AGENT_TOOL')
    expect(verdict.pattern_id).toBe('agent_selfloop')
    expect(verdict.ancestors).toEqual(['agent_selfloop'])
  })

  it('rejects A → B → A (a pattern already on the ancestor chain)', async () => {
    // Chain: agent_ring --tool--> meta_hop --step--> agent_leaf --tool--> meta_hop
    // At agent_leaf the visited set is {agent_ring, meta_hop, agent_leaf}, so
    // re-entering meta_hop closes the ring. Note that maxAgentDepth cannot see
    // this: only 2 of the 3 ancestors are agents, and the ring could be widened
    // with more metas indefinitely without raising that count.
    const h = makeHarness({
      patterns: [
        agent('agent_ring', ['meta_hop']),
        hopMeta('meta_hop', 'agent_leaf'),
        agent('agent_leaf', ['meta_hop']),
      ],
      scripts: {
        agent_ring: [dispatchStep('meta_hop', 'down', 'tc-ring')],
        agent_leaf: [dispatchStep('meta_hop', 'again', 'tc-leaf')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_ring',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const verdict = h.results.agent_leaf?.[0] as GuardVerdict
    expect(verdict.code).toBe('CIRCULAR_AGENT_TOOL')
    expect(verdict.pattern_id).toBe('meta_hop')
    expect(verdict.caller_pattern_id).toBe('agent_leaf')
    // The full chain is echoed so a host can log where the ring formed.
    expect(verdict.ancestors).toEqual(['agent_ring', 'meta_hop', 'agent_leaf'])
    expect(verdict.message).toContain('agent_leaf → meta_hop')
    // The ring stopped at the second hop: meta_hop's own model-free step ran
    // once, and the leaf's re-entry never reached a second dispatch.
    expect(h.results.agent_ring?.[0]).not.toMatchObject({ code: 'CIRCULAR_AGENT_TOOL' })
  })

  it('does not flag a repeated SIBLING call as a cycle', async () => {
    // The classic false positive: mutating `visited` when a tool call is
    // brokered (instead of copying it into the child) makes the second call to
    // the same pattern look like an ancestor revisit. dispatchAgent passes
    // `[...visited]` to submitChild and never mutates its own set, so two
    // sibling calls must BOTH succeed.
    const h = makeHarness({
      patterns: [atomic('shared_atomic'), agent('agent_fanout', ['shared_atomic'])],
      scripts: {
        agent_fanout: [
          // Distinct inputs so idempotency dedup cannot silently collapse the
          // second dispatch into the first and hide a regression.
          dispatchStep('shared_atomic', 'first', 'tc-1'),
          dispatchStep('shared_atomic', 'second', 'tc-2'),
        ],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_fanout',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(h.results.agent_fanout).toEqual([
      { modality: 'text', text: 'ok' },
      { modality: 'text', text: 'ok' },
    ])
    expect(h.calls.count).toBe(2)
  })

  it('does not flag a pattern used in a completed sibling BRANCH as an ancestor', async () => {
    // Harder variant of the same trap, across dispatch levels: agent_branch
    // finishes a shared_atomic call, then descends through meta_hop into
    // agent_deep, which calls shared_atomic again. shared_atomic is on a
    // settled sibling branch, never on agent_deep's ancestor chain
    // ({agent_branch, meta_hop, agent_deep}) — a `visited` set that accumulated
    // across siblings instead of forking per child would wrongly reject it.
    const h = makeHarness({
      patterns: [
        atomic('shared_atomic'),
        agent('agent_branch', ['shared_atomic', 'meta_hop']),
        hopMeta('meta_hop', 'agent_deep'),
        agent('agent_deep', ['shared_atomic']),
      ],
      scripts: {
        agent_branch: [
          dispatchStep('shared_atomic', 'branch-first', 'tc-1'),
          dispatchStep('meta_hop', 'descend', 'tc-2'),
        ],
        agent_deep: [dispatchStep('shared_atomic', 'deep-again', 'tc-3')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_branch',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(h.results.agent_branch?.[0]).toEqual({ modality: 'text', text: 'ok' })
    expect(h.results.agent_deep?.[0]).toEqual({ modality: 'text', text: 'ok' })
    expect(h.calls.count).toBe(2)
  })
})

// ── How a guard verdict reaches the host ───────────────────────────────────
//
// Deliberate asymmetry with the other recursion guard, worth pinning because it
// is easy to "fix" in the wrong direction: these two verdicts are RETURNED as
// tool-results (the LLM reads them and picks another pattern_id), whereas
// AGENT_DEPTH_EXCEEDED is THROWN and fails the job. Turning the tool-call
// guards into throws would make every hallucinated pattern id stream-fatal for
// the whole agent run.
describe('guard verdicts on the host-visible surface', () => {
  it('is a tool-result, not a JobError: the job completes and the payload is machine-readable', async () => {
    const h = makeHarness({
      patterns: [
        atomic('allowed_atomic'),
        atomic('forbidden_atomic'),
        agent('agent_scoped', ['allowed_atomic']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('forbidden_atomic', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    // No JobError: a refused tool call is the loop self-correcting, not a run
    // failure.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()

    // The verdict must be readable by field, never by regexing the prose — a
    // host routing on `code` is the whole point of having codes.
    const verdict = h.results.agent_scoped?.[0] as GuardVerdict
    expect(typeof verdict.code).toBe('string')
    expect(typeof verdict.pattern_id).toBe('string')
    expect(Array.isArray(verdict.allowlist)).toBe(true)
    expect(typeof verdict.hint).toBe('string')

    // The agent envelope is the host's own read-back surface; a refused call is
    // not a brokered tool use and must not inflate its counter.
    const envelope = h.runtime.getAgentEnvelope(h.rootJobId())
    expect(envelope?.status).toBe('completed')
    expect(envelope?.totalToolUseCount).toBe(0)
  })

  it('contrasts with AGENT_DEPTH_EXCEEDED, which throws and lands on JobError', async () => {
    // Same harness, the throwing guard: agent_ring --tool--> meta_hop --step-->
    // agent_leaf with maxAgentDepth=0. agent_leaf sees 1 agent ancestor,
    // dispatchAgent throws, and the failure propagates all the way up to the
    // root job instead of coming back as a tool-result.
    const h = makeHarness({
      patterns: [
        agent('agent_ring', ['meta_hop']),
        hopMeta('meta_hop', 'agent_leaf'),
        agent('agent_leaf', []),
      ],
      scripts: {
        agent_ring: [dispatchStep('meta_hop', 'down', 'tc-ring')],
      },
      maxAgentDepth: 0,
    })
    const job = await h.runtime.submitJob({ patternId: 'agent_ring', input: { prompt: 'start' } })
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/AGENT_DEPTH_EXCEEDED/)

    // The thrown Error carries `.code`, so normaliseError lifts the guard's
    // own name onto JobError instead of falling back to the generic
    // DISPATCH_EXECUTE_FAILED — a host routes on the code and never has to
    // regex the message. The two tool-call guards above never reach this
    // surface at all.
    const rootJob = await h.store.get(h.rootJobId())
    expect(rootJob?.status).toBe('error')
    expect(rootJob?.error?.code).toBe('AGENT_DEPTH_EXCEEDED')
    expect(rootJob?.error?.message).toContain('AGENT_DEPTH_EXCEEDED')
  })
})

// ── job:tool-rejected ──────────────────────────────────────────────────────
//
// The verdicts above are returned to the LLM, which means that without an
// event they are visible ONLY inside the model's context window: a refused
// call touches neither the job row (it still ends `done`, `error: null`) nor
// the envelope's tool counter. `job:tool-rejected` is the host's channel for
// them — "this agent tried to reach outside its scope" is exactly the kind of
// fact a local-first host should be able to audit and replay.
//
// Each case pins the reason-specific payload, because that is the part a
// generic "something was refused" event would lose: the allowlist the call was
// judged against, the chain a cycle would have closed, which half of the
// blocklist matched.
describe('job:tool-rejected', () => {
  it('reports an out-of-scope call with the allowlist it was judged against', async () => {
    const h = makeHarness({
      patterns: [
        atomic('allowed_atomic'),
        atomic('forbidden_atomic'),
        agent('agent_scoped', ['allowed_atomic']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('forbidden_atomic', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })

    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('SUBAGENT_TOOL_OUT_OF_SCOPE')
    expect(ev.patternId).toBe('forbidden_atomic')
    expect(ev.callerPatternId).toBe('agent_scoped')
    if (ev.code !== 'SUBAGENT_TOOL_OUT_OF_SCOPE') throw new Error('unreachable')
    expect(ev.allowlist).toEqual(['allowed_atomic'])
    // Fired on the agent's own stream, carrying the live snapshot.
    expect(ev.job.id).toBe(job.id)
    expect(ev.job.status).toBe('running')

    // Delivered while the job is still live, ahead of its terminal event.
    // This is the contract a host reads against: `fanout` releases the
    // subscriber set once a terminal event goes out, so a rejection that lost
    // the race would be dropped outright, not merely arrive late.
    expect(h.events.indexOf(ev)).toBeLessThan(terminalIndex(h, job.id))

    // The event is additive, not a reclassification: the guard's other
    // observable properties are unchanged.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(0)
  })

  it('reports the NARROWED allowlist for an async agent, not the raw toolPatternIds', async () => {
    // Same intersection the guard itself reads (toolPatternIds ∩
    // asyncToolPatternIds). A host told the raw list would conclude the
    // rejection was a runtime bug.
    const h = makeHarness({
      patterns: [
        atomic('async_ok'),
        atomic('sync_only'),
        agent('agent_async', ['async_ok', 'sync_only'], {
          defaultExecutionMode: 'async',
          loop: {
            system: 'sys',
            toolPatternIds: ['async_ok', 'sync_only'],
            asyncToolPatternIds: ['async_ok'],
            modelTags: [],
          },
        }),
      ],
      scripts: {
        agent_async: [
          dispatchStep('sync_only', 'nope', 'tc-1'),
          dispatchStep('async_ok', 'yes', 'tc-2'),
        ],
      },
    })
    await h.runtime.submitJob({ patternId: 'agent_async', input: { prompt: 'start' } })

    const evs = rejections(h)
    // Exactly one: the allowed sibling call must not emit a rejection.
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    if (ev.code !== 'SUBAGENT_TOOL_OUT_OF_SCOPE') throw new Error('unreachable')
    expect(ev.patternId).toBe('sync_only')
    expect(ev.allowlist).toEqual(['async_ok'])
  })

  it('reports a cycle with the ancestor chain, on the nested agent that closed it', async () => {
    // agent_ring --tool--> meta_hop --step--> agent_leaf --tool--> meta_hop.
    // The rejection belongs to agent_leaf's job, not the root's — a host
    // subscribed only to the root would see nothing, which is why the harness
    // collects the whole tree.
    const h = makeHarness({
      patterns: [
        agent('agent_ring', ['meta_hop']),
        hopMeta('meta_hop', 'agent_leaf'),
        agent('agent_leaf', ['meta_hop']),
      ],
      scripts: {
        agent_ring: [dispatchStep('meta_hop', 'down', 'tc-ring')],
        agent_leaf: [dispatchStep('meta_hop', 'again', 'tc-leaf')],
      },
    })
    const root = await h.runtime.submitJob({
      patternId: 'agent_ring',
      input: { prompt: 'start' },
    })

    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('CIRCULAR_AGENT_TOOL')
    expect(ev.patternId).toBe('meta_hop')
    expect(ev.callerPatternId).toBe('agent_leaf')
    if (ev.code !== 'CIRCULAR_AGENT_TOOL') throw new Error('unreachable')
    expect(ev.ancestors).toEqual(['agent_ring', 'meta_hop', 'agent_leaf'])
    expect(ev.job.id).not.toBe(root.id)
    expect(h.events.indexOf(ev)).toBeLessThan(terminalIndex(h, ev.job.id))
    expect(root.status).toBe('done')
  })

  it('reports a blocklist hit and which half of the blocklist matched', async () => {
    // agent_caller opts agent_blocked into its own toolPatternIds — an
    // authoring mistake the blocklist exists to catch. agent_blocked is NOT on
    // the ancestor chain and IS in the allowlist, so this is the only one of
    // the three guards that can fire.
    const h = makeHarness({
      patterns: [
        agent('agent_caller', ['agent_blocked']),
        agent('agent_blocked', []),
      ],
      scripts: {
        agent_caller: [dispatchStep('agent_blocked', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })

    // Precondition: the tool-result the model saw agrees with the event, so
    // the test is about the blocklist and not about guard ordering.
    expect((h.results.agent_caller?.[0] as GuardVerdict).code).toBe('SUBAGENT_BLOCKED')

    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('SUBAGENT_BLOCKED')
    expect(ev.patternId).toBe('agent_blocked')
    expect(ev.callerPatternId).toBe('agent_caller')
    if (ev.code !== 'SUBAGENT_BLOCKED') throw new Error('unreachable')
    // `agent_` is a DEFAULT_SUBAGENT_BLOCKLIST id PREFIX, not an exact id.
    expect(ev.matched).toBe('prefix')
    expect(h.events.indexOf(ev)).toBeLessThan(terminalIndex(h, job.id))
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(0)
  })

  it('stays silent when nothing is refused (positive control)', async () => {
    // A guard wired to emit unconditionally would be just as wrong as one that
    // never emits, and every assertion above would still pass.
    const h = makeHarness({
      patterns: [atomic('allowed_atomic'), agent('agent_scoped', ['allowed_atomic'])],
      scripts: {
        agent_scoped: [dispatchStep('allowed_atomic', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(rejections(h)).toEqual([])
    // The successful call DID broker a tool use, so the counter moved — which
    // is what makes the 0 asserted above meaningful.
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(1)
  })
})
