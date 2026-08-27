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
  DiagnosticsLogger,
  ExecutionContext,
  JobEvent,
  MetaPattern,
  Modality,
  ModelCapability,
  PatternId,
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

/**
 * A meta that steps into each of `steps` in order and, unless
 * `declares: 'nothing'`, DECLARES that step list through `plannedDispatches`.
 * Declaration and behaviour agree by construction, which is the point: the
 * guard judges the declaration, and the compose below is what actually spends
 * if the guard lets the call through (each step is one fake-model call, so
 * `calls.count` distinguishes "refused before submitChild" from "refused
 * after").
 *
 * `declares: 'throws'` is the pattern-author bug case — a declaration that
 * raises instead of returning a list.
 */
function declaringMeta(
  id: string,
  steps: readonly string[],
  declares: 'steps' | 'nothing' | 'throws' = 'steps',
): MetaPattern {
  return {
    id,
    kind: 'meta',
    description: `meta stepping into ${steps.join(', ')}`,
    tool: { description: id, inputs: PROMPT_INPUT },
    outputs: z.object({ done: z.boolean() }),
    ...(declares === 'nothing'
      ? {}
      : {
          plannedDispatches:
            declares === 'throws'
              ? () => {
                  throw new Error('plannedDispatches is buggy')
                }
              : () => steps as readonly PatternId[],
        }),
    async compose(args: { input: unknown }, ctx: ExecutionContext) {
      for (const step of steps) {
        await ctx.step({
          patternId: step as PatternId,
          input: { prompt: (args.input as { prompt?: string }).prompt ?? 'x' },
        })
      }
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
  /** The runtime's diagnostics seam — injected only where a test asserts on it. */
  logger?: DiagnosticsLogger
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
    ...(opts.logger ? { logger: opts.logger } : {}),
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
  /** Present only on a declared-dispatch refusal: the inner id that offended. */
  via?: string
  reason?: 'prefix' | 'id'
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
    // `via` is reserved for refusals judged one level down, on a meta's
    // DECLARED inner dispatch — a direct refusal must not carry it, or a host
    // could no longer tell the two apart.
    expect(ev.via).toBeUndefined()
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

// ── plannedDispatches — the same three guards, one level down ──────────────
//
// The three guards above judge the id the loop asked for. A meta reached
// THROUGH that call inherits nothing today: `_submitJobInternal` checks only
// `registry.get`, and `ctx.step` adds only DUPLICATE_STEP_ID /
// CIRCULAR_META_STEP — so a meta in `toolPatternIds` can step into anything
// registered, including patterns the agent was never scoped to. When a meta
// DECLARES its dispatch set (`MetaPattern.plannedDispatches`), every declared
// id is put through the same three judgements before `submitChild`, and the
// first offender refuses the whole call with nothing dispatched.
//
// The refusal is the direct guard's own shape plus `via`, the declared id that
// offended. `pattern_id` stays the id the loop actually called, so the model
// can tell WHICH of its calls was refused; `via` tells it why.
//
// Two negative controls carry as much weight as the refusals: an in-scope
// declaration must still dispatch (a guard stuck on "refuse everything" would
// break every plan), and an UNDECLARED meta must still be able to step out of
// scope (that bypass is deliberately left open here — see below).
describe('plannedDispatches', () => {
  it('refuses an out-of-scope declared dispatch, naming it in `via`', async () => {
    const h = makeHarness({
      patterns: [
        atomic('forbidden_atomic'),
        declaringMeta('meta_declared', ['forbidden_atomic']),
        agent('agent_scoped', ['meta_declared']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('meta_declared', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()

    const verdict = h.results.agent_scoped?.[0] as GuardVerdict
    expect(verdict.code).toBe('SUBAGENT_TOOL_OUT_OF_SCOPE')
    // The call the model made, and the declared step that sank it.
    expect(verdict.pattern_id).toBe('meta_declared')
    expect(verdict.via).toBe('forbidden_atomic')
    expect(verdict.caller_pattern_id).toBe('agent_scoped')
    expect(verdict.allowlist).toEqual(['meta_declared'])
    expect(verdict.message).toContain('forbidden_atomic')

    // Nothing was dispatched: the meta's compose never ran, so its step never
    // reached the fake model. A guard that refused AFTER submitChild would
    // have paid for the call it was refusing.
    expect(h.calls.count).toBe(0)
    // ... and the refused call brokered no tool use.
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(0)

    // Host-visible, on the agent's own stream, ahead of the terminal event.
    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('SUBAGENT_TOOL_OUT_OF_SCOPE')
    expect(ev.patternId).toBe('meta_declared')
    expect(ev.callerPatternId).toBe('agent_scoped')
    // The event names the declared offender too — an auditor must not have to
    // re-run plannedDispatches to learn why an in-scope call was refused.
    expect(ev.via).toBe('forbidden_atomic')
    if (ev.code !== 'SUBAGENT_TOOL_OUT_OF_SCOPE') throw new Error('unreachable')
    expect(ev.allowlist).toEqual(['meta_declared'])
    expect(h.events.indexOf(ev)).toBeLessThan(terminalIndex(h, job.id))
  })

  it('refuses a blocklisted declared dispatch (SUBAGENT_BLOCKED + via)', async () => {
    // `agent_blocked` is IN the agent's allowlist (the authoring mistake the
    // blocklist exists to catch) and NOT on the ancestor chain, so the
    // blocklist is the only one of the three that can fire — the same setup as
    // the direct-guard case above, one level down.
    const h = makeHarness({
      patterns: [
        agent('agent_blocked', []),
        declaringMeta('meta_declared', ['agent_blocked']),
        agent('agent_caller', ['meta_declared', 'agent_blocked']),
      ],
      scripts: {
        agent_caller: [dispatchStep('meta_declared', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const verdict = h.results.agent_caller?.[0] as GuardVerdict
    expect(verdict.code).toBe('SUBAGENT_BLOCKED')
    expect(verdict.pattern_id).toBe('meta_declared')
    expect(verdict.via).toBe('agent_blocked')
    // `agent_` is a blocklist id PREFIX, not an exact id — and the half that
    // matched is judged on the DECLARED id, not on the meta.
    expect(verdict.reason).toBe('prefix')
    expect(h.calls.count).toBe(0)

    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('SUBAGENT_BLOCKED')
    expect(ev.via).toBe('agent_blocked')
    if (ev.code !== 'SUBAGENT_BLOCKED') throw new Error('unreachable')
    expect(ev.matched).toBe('prefix')
    expect(ev.patternId).toBe('meta_declared')
  })

  it('refuses a declared dispatch of a pattern on the ancestor chain', async () => {
    // agent_ring --tool--> meta_hop --step--> agent_leaf --tool-->
    // meta_declared, which declares it would step back into meta_hop. At
    // agent_leaf the visited set is {agent_ring, meta_hop, agent_leaf}, so the
    // declaration closes the ring one level below the call the loop made.
    // meta_hop is in agent_leaf's allowlist and carries no blocklist prefix,
    // so the ancestor check is the only one that can fire.
    const h = makeHarness({
      patterns: [
        agent('agent_ring', ['meta_hop']),
        hopMeta('meta_hop', 'agent_leaf'),
        declaringMeta('meta_declared', ['meta_hop']),
        agent('agent_leaf', ['meta_declared', 'meta_hop']),
      ],
      scripts: {
        agent_ring: [dispatchStep('meta_hop', 'down', 'tc-ring')],
        agent_leaf: [dispatchStep('meta_declared', 'again', 'tc-leaf')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_ring',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const verdict = h.results.agent_leaf?.[0] as GuardVerdict
    expect(verdict.code).toBe('CIRCULAR_AGENT_TOOL')
    expect(verdict.pattern_id).toBe('meta_declared')
    expect(verdict.via).toBe('meta_hop')
    expect(verdict.caller_pattern_id).toBe('agent_leaf')
    expect(verdict.ancestors).toEqual(['agent_ring', 'meta_hop', 'agent_leaf'])
    expect(verdict.message).toContain('meta_declared → meta_hop')

    const evs = rejections(h)
    expect(evs).toHaveLength(1)
    const ev = evs[0]!
    expect(ev.code).toBe('CIRCULAR_AGENT_TOOL')
    expect(ev.via).toBe('meta_hop')
    if (ev.code !== 'CIRCULAR_AGENT_TOOL') throw new Error('unreachable')
    expect(ev.ancestors).toEqual(['agent_ring', 'meta_hop', 'agent_leaf'])
    // Fired on the nested agent's job, not the root's.
    expect(ev.job.id).not.toBe(job.id)
  })

  it('lets a fully in-scope declaration through (positive control)', async () => {
    const h = makeHarness({
      patterns: [
        atomic('allowed_atomic'),
        declaringMeta('meta_declared', ['allowed_atomic']),
        agent('agent_scoped', ['meta_declared', 'allowed_atomic']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('meta_declared', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    // The meta ran: its declared step reached the fake model and its own
    // declared output came back to the loop, with no guard code in sight.
    expect(h.results.agent_scoped?.[0]).toEqual({ done: true })
    expect(h.calls.count).toBe(1)
    expect(rejections(h)).toEqual([])
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(1)
  })

  it('leaves an UNDECLARED meta free to step outside the allowlist (status quo, pinned)', async () => {
    // The bypass this guard deliberately does NOT close: docs/plan.md, "We
    // don't close the allowlist bypass for hand-written metas here" — it
    // predates plans, this suite's own A → B → A ring depends on a meta
    // stepping into a pattern the agent never listed, and closing it is a
    // decision about every meta rather than a property of plannedDispatches.
    // `plannedDispatches` absent means "not knowable", so the call proceeds
    // exactly as it did before this guard existed.
    const h = makeHarness({
      patterns: [
        atomic('forbidden_atomic'),
        declaringMeta('meta_silent', ['forbidden_atomic'], 'nothing'),
        agent('agent_scoped', ['meta_silent']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('meta_silent', 'go', 'tc-1')],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(h.results.agent_scoped?.[0]).toEqual({ done: true })
    // forbidden_atomic is nowhere in agent_scoped's allowlist, and it ran.
    expect(h.calls.count).toBe(1)
    expect(rejections(h)).toEqual([])
  })

  it('treats a THROWING declaration as undeclared, reporting it on the diagnostics seam', async () => {
    // A declaration is an author's optional hint evaluated on the dispatch
    // path. If it throws, the guard must add no crash path and no refusal: a
    // buggy `plannedDispatches` would otherwise be a denial of service written
    // by the pattern author, and a fail-closed guard here would make opting in
    // strictly riskier than staying silent. The attempt has no job of its own
    // to report on, so it goes to the injected DiagnosticsLogger — never the
    // console, which the runtime does not own.
    const warns: Array<{ message: string; detail?: unknown }> = []
    const logger: DiagnosticsLogger = {
      warn: (message, detail) => warns.push({ message, detail }),
      error: () => undefined,
    }
    const h = makeHarness({
      patterns: [
        atomic('forbidden_atomic'),
        declaringMeta('meta_buggy', ['forbidden_atomic'], 'throws'),
        agent('agent_scoped', ['meta_buggy']),
      ],
      scripts: {
        agent_scoped: [dispatchStep('meta_buggy', 'go', 'tc-1')],
      },
      logger,
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_scoped',
      input: { prompt: 'start' },
    })
    // Dispatch proceeded, exactly as for an undeclared meta.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(h.results.agent_scoped?.[0]).toEqual({ done: true })
    expect(h.calls.count).toBe(1)
    expect(rejections(h)).toEqual([])

    // ... and the host was told, by name, that this meta's steps went
    // unchecked.
    const noted = warns.filter((w) => w.message.includes('plannedDispatches'))
    expect(noted).toHaveLength(1)
    expect(noted[0]!.message).toContain('meta_buggy')
    expect((noted[0]!.detail as Error).message).toBe('plannedDispatches is buggy')
  })
})

// ── The blocklist beats an explicit toolPatternIds listing ─────────────────
//
// Three places in this repo used to describe the same mechanism differently:
// the catalog exclusion let an author's `loop.toolPatternIds` entry keep an
// `agent_` id discoverable, while `onToolCall` refused that very id at
// dispatch. The catalog advertised a tool the model could find and never call.
// One rule now: the default blocklist wins, everywhere.
describe('an agent_ id listed in loop.toolPatternIds', () => {
  it('is not discoverable through find_pattern either', async () => {
    // `select:<id>` is the deterministic selector — no BM25 ranking in the
    // way, so an empty result means the corpus filter refused it and nothing
    // else. The second call is the positive control: the same corpus, the
    // same selector shape, an id that is genuinely dispatchable here.
    const h = makeHarness({
      patterns: [
        agent('agent_caller', ['agent_blocked', 'allowed_atomic']),
        agent('agent_blocked', []),
        atomic('allowed_atomic'),
      ],
      scripts: {
        agent_caller: [
          { name: 'find_pattern', input: { query: 'select:agent_blocked' }, callId: 'tc-1' },
          { name: 'find_pattern', input: { query: 'select:allowed_atomic' }, callId: 'tc-2' },
        ],
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const blockedSearch = h.results.agent_caller?.[0] as {
      matches?: readonly { patternId: string }[]
    }
    expect((blockedSearch.matches ?? []).map((m) => m.patternId)).toEqual([])

    const allowedSearch = h.results.agent_caller?.[1] as {
      matches?: readonly { patternId: string }[]
    }
    expect((allowedSearch.matches ?? []).map((m) => m.patternId)).toEqual([
      'allowed_atomic',
    ])
  })

  it('is still refused at dispatch, with the same SUBAGENT_BLOCKED shape', async () => {
    // The catalog and the guard now agree; this pins that closing the catalog
    // hole did not quietly open the dispatch one.
    const h = makeHarness({
      patterns: [agent('agent_caller', ['agent_blocked']), agent('agent_blocked', [])],
      scripts: { agent_caller: [dispatchStep('agent_blocked', 'go', 'tc-1')] },
    })
    await h.runtime.submitJob({ patternId: 'agent_caller', input: { prompt: 'start' } })
    const verdict = h.results.agent_caller?.[0] as GuardVerdict
    expect(verdict.code).toBe('SUBAGENT_BLOCKED')
    expect(verdict.reason).toBe('prefix')
  })
})
