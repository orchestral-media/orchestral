// What an agent loop sees when a tool dispatch FAILS.
//
// `submitChild` is `_submitJobInternal`, which throws on every fresh dispatch
// failure — so before this file existed, a failed sub-dispatch rejected out of
// `onToolCall` and killed the run: the model never learned which of its calls
// failed or why, and the Pattern's own structured error (`planStepId` for a
// plan step, `issues` for an output-schema mismatch) died with it.
// `SUBAGENT_TOOL_FAILED`, built for exactly this, was reachable only through a
// non-conforming store handing back a cached errored row.
//
// The contract pinned here: a failed child is DATA the loop reads and acts on
// — the same choice the tool-call guards make (agent-tool-guards.test.ts) —
// and the agent job still settles `done`. Two things stay throws, because a
// tool result would be the wrong answer:
//
//   • CANCELLED — an abort must end the run. A cancelled agent that keeps
//     dispatching is a cancel that did not work.
//   • host-wiring bugs the model cannot fix (ASK_USER_NOT_SUPPORTED,
//     AGENT_RUN_IMPL_NOT_INJECTED, AGENT_ASSET_BRIDGE_MISSING) and the agent
//     recursion budget (AGENT_DEPTH_EXCEEDED, whose thrown contract
//     agent-tool-guards.test.ts pins).
//
// Harness: a real InlineRuntime over an in-memory JobStore, a scripted fake
// AgentRunImpl that drives `onToolCall` and records what came back, and a
// child META whose compose is supplied per test — a meta reaches the failure
// path without a provider in the way (no fallback walk, no retry), which is
// also the shape a plan step fails in.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  CapabilityRouter,
  ExecutionContext,
  MetaPattern,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  InMemoryJobStore as MemoryJobStore,
  InMemoryTranscriptStore,
  PatternRegistry,
} from '@orchestral/core'

import { InlineRuntime } from '../inline'
import type { AgentRunImpl } from '../agent-run'

const PROMPT_INPUT = z.object({ prompt: z.string() })

// Present only because InlineRuntime requires a router; the child meta below
// never calls a model.
function makeRouter(): CapabilityRouter {
  const cap = {
    modelId: 'fake:m',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

/**
 * The child the agent dispatches. `behaviour` runs inside compose, so a throw
 * is a genuine dispatch failure (markErrored + rethrow out of
 * `_submitJobInternal`), and a returned value that misses `outputs` fails the
 * dispatch-exit output gate — the one failure whose `details` carries
 * `rawOutput`.
 */
function childMeta(behaviour: (call: number) => unknown): MetaPattern {
  let calls = 0
  return {
    id: 'meta_child',
    kind: 'meta',
    description: 'child whose failure mode the test controls',
    tool: { description: 'run the child', inputs: PROMPT_INPUT },
    outputs: z.object({ ok: z.boolean() }),
    async compose() {
      return behaviour(calls++)
    },
  } as unknown as MetaPattern
}

function callerAgent(): AgentPattern {
  return {
    id: 'agent_caller',
    kind: 'agent',
    description: 'agent that dispatches meta_child',
    primary: { tool: { description: 'run', inputs: PROMPT_INPUT } },
    loop: { system: 'sys', toolPatternIds: ['meta_child'], modelTags: [] },
  } as unknown as AgentPattern
}

interface LoopTrace {
  /** Tool results the loop was handed, in order. */
  results: unknown[]
  /** Set once the loop reached the finish tool — false if a throw killed it. */
  finished: boolean
}

/**
 * Fake AgentRunImpl driving `prompts.length` dispatch_pattern calls and then
 * the finish tool. A rejected `onToolCall` propagates (rule 4 in agent-run.ts
 * says the runtime resolves recoverable failures, so an implementation is free
 * to let a rejection be fatal) — which is what makes `finished` meaningful.
 */
function makeRunImpl(prompts: readonly string[], trace: LoopTrace): AgentRunImpl {
  return {
    async run(args) {
      for (const [i, prompt] of prompts.entries()) {
        trace.results.push(
          await args.onToolCall({
            name: 'dispatch_pattern',
            input: { pattern_id: 'meta_child', input: { prompt } },
            callId: `tc-${i + 1}`,
          }),
        )
      }
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      trace.finished = true
      return { text: 'done' }
    },
  }
}

function makeHarness(opts: {
  behaviour: (call: number) => unknown
  prompts?: readonly string[]
  transcriptStore?: InMemoryTranscriptStore
}) {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(childMeta(opts.behaviour) as never)
  registry.register(callerAgent() as never)
  const trace: LoopTrace = { results: [], finished: false }
  const store = new MemoryJobStore()
  const runtime = new InlineRuntime({
    store: store as never,
    registry,
    router: makeRouter(),
    agentRunImpl: makeRunImpl(opts.prompts ?? ['go'], trace),
    logger: silentDiagnosticsLogger,
    ...(opts.transcriptStore ? { transcriptStore: opts.transcriptStore } : {}),
  })
  return { runtime, store, trace }
}

/** The failure tool-result shape. */
interface FailureResult {
  code?: string
  pattern_id?: string
  error_class?: string
  inner_code?: string
  message?: string
  hint?: string
  details?: Record<string, unknown>
}

describe('SUBAGENT_TOOL_FAILED reaches the loop', () => {
  it('hands a coded child failure back as a tool result and the loop keeps going', async () => {
    const h = makeHarness({
      // First call fails, second succeeds — proving the loop was still alive
      // and that the same tool works again after a refusal to work once.
      behaviour: (call) => {
        if (call === 0) {
          throw Object.assign(new Error('the child gave up'), { code: 'CHILD_EXPLODED' })
        }
        return { ok: true }
      },
      prompts: ['first', 'second'],
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })

    // The run is not a failure: a failed tool call is the loop's problem to
    // solve, not the job's cause of death.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
    expect(h.trace.finished).toBe(true)

    const failure = h.trace.results[0] as FailureResult
    expect(failure.code).toBe('SUBAGENT_TOOL_FAILED')
    expect(failure.pattern_id).toBe('meta_child')
    // The child's OWN code — the whole point of the shape. Without it the
    // model reads "something failed" and has nothing to route on.
    expect(failure.inner_code).toBe('CHILD_EXPLODED')
    expect(failure.message).toContain('the child gave up')
    expect(failure.error_class).toBe('other')
    expect(typeof failure.hint).toBe('string')
    // Nothing to pass through: an error with no structured details grows no
    // empty `details` key.
    expect(failure.details).toBeUndefined()

    // The loop continued to the second call, which succeeded.
    expect(h.trace.results[1]).toEqual({ ok: true })
    // Only the successful dispatch brokered a tool use; the failed one is
    // still a real (paid-for) dispatch, so it is NOT counted like a refusal —
    // it counted nothing because it produced nothing.
    expect(h.runtime.getAgentEnvelope(job.id)?.status).toBe('completed')
    expect(h.runtime.getAgentEnvelope(job.id)?.totalToolUseCount).toBe(1)
  })

  it('passes details.planStepId through, so the model can name the step that failed', async () => {
    // A plan is a meta: one job, one row, and `job.error.details.planStepId`
    // is what names WHICH step of the pipeline died. Before the failure had a
    // shape, that field could not reach the model at all.
    const h = makeHarness({
      behaviour: () => {
        throw Object.assign(new Error('step 2 of the plan failed'), {
          code: 'META_STEP_FAILED',
          details: { planStepId: 'render_hero', stepIndex: 2 },
        })
      },
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const failure = h.trace.results[0] as FailureResult
    expect(failure.inner_code).toBe('META_STEP_FAILED')
    expect(failure.details).toEqual({ planStepId: 'render_hero', stepIndex: 2 })
  })

  it('drops details.rawOutput — host-facing salvage never enters model context', async () => {
    // The output gate's `details` carries `{patternId, kind, issues, rawOutput}`.
    // `rawOutput` is the ENTIRE value that failed the schema: unbounded and
    // unprojected, the two things a tool result must never be. It stays on the
    // child's JobError for the host; `issues` (path + message) is what the
    // model needs and gets.
    const secret = `signed-url-${'x'.repeat(500)}`
    const h = makeHarness({
      behaviour: () => ({ wrong: 'shape', leak: secret }),
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    const failure = h.trace.results[0] as FailureResult
    expect(failure.inner_code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(failure.details?.patternId).toBe('meta_child')
    expect(Array.isArray(failure.details?.issues)).toBe(true)
    expect(failure.details?.rawOutput).toBeUndefined()
    // Nowhere else in the payload either — a `message` that embedded the value
    // would leak it just as effectively.
    expect(JSON.stringify(failure)).not.toContain(secret)

    // ... and the host still has it, on the child's own row.
    const childRow = (await h.store.query()).find((j) => j.patternId === 'meta_child')
    expect(childRow?.status).toBe('error')
    expect((childRow?.error?.details as { rawOutput?: unknown }).rawOutput).toEqual({
      wrong: 'shape',
      leak: secret,
    })
  })

  it('classifies a 4xx provider refusal as invalid-input, lifting httpStatus into details', async () => {
    // normaliseError lifts a stamped `httpStatus` off the throw and into
    // JobError.details; the classification then reads it the same way on the
    // fresh path as on the cached one.
    const h = makeHarness({
      behaviour: () => {
        throw Object.assign(new Error('unsupported parameter: seed'), {
          code: 'PROVIDER_REJECTED',
          httpStatus: 400,
        })
      },
    })
    await h.runtime.submitJob({ patternId: 'agent_caller', input: { prompt: 'start' } })

    const failure = h.trace.results[0] as FailureResult
    expect(failure.error_class).toBe('invalid-input')
    expect(failure.details?.httpStatus).toBe(400)
    expect(failure.hint).toContain('HTTP 4xx')
  })

  it('records the failure tool-result in the transcript, like any model-facing result', async () => {
    // The transcript is replayed straight back into model context on resume,
    // so it must hold what the model saw — and the model saw this. Leaving it
    // out would resume a loop into a history where the failed call never
    // happened, inviting it to make the same call again.
    const transcriptStore = new InMemoryTranscriptStore()
    const h = makeHarness({
      behaviour: () => {
        throw Object.assign(new Error('the child gave up'), { code: 'CHILD_EXPLODED' })
      },
      transcriptStore,
    })
    const job = await h.runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    // runId is the dispatching job's own id for a fresh (non-resumed) run.
    const entries = await transcriptStore.readAll(job.id)
    const toolResults = entries.filter((m) => m.kind === 'tool-result')
    expect(toolResults).toHaveLength(1)
    const raw = toolResults[0]!.raw as { pattern_id?: string; output?: FailureResult }
    expect(raw.pattern_id).toBe('meta_child')
    expect(raw.output?.code).toBe('SUBAGENT_TOOL_FAILED')
    expect(raw.output?.inner_code).toBe('CHILD_EXPLODED')
    // Byte-for-byte what the loop was handed.
    expect(raw.output).toEqual(h.trace.results[0])
  })
})

describe('what still throws', () => {
  it('a CANCELLED child kills the loop: the agent job cancels, no tool result is handed back', async () => {
    // Cooperative cancellation: cancelJob aborts the agent's controller, the
    // cascade aborts the in-flight child, and the child's dispatch throws
    // CANCELLED at its next guard. That must NOT come back as a tool result —
    // a model handed "your last call was cancelled" would simply try again,
    // and the run the user cancelled would keep spending.
    let releaseChild!: () => void
    const childGate = new Promise<void>((r) => {
      releaseChild = r
    })
    let enteredChild!: () => void
    const childEntered = new Promise<void>((r) => {
      enteredChild = r
    })

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(
      childMeta(async () => {
        enteredChild()
        await childGate
        return { ok: true }
      }) as never,
    )
    registry.register(callerAgent() as never)
    const trace: LoopTrace = { results: [], finished: false }
    const store = new MemoryJobStore()
    const ids: string[] = []
    const runtime = new InlineRuntime({
      store: store as never,
      registry,
      router: makeRouter(),
      agentRunImpl: makeRunImpl(['go'], trace),
      logger: silentDiagnosticsLogger,
      onJobCreated: (id) => ids.push(id),
    })

    const pending = runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    await childEntered
    // onJobCreated fires per dispatch in creation order: [agent, child].
    expect(ids).toHaveLength(2)
    const [agentJobId, childJobId] = ids

    await runtime.cancelJob(agentJobId!)
    releaseChild()
    const job = await pending

    expect(job.status).toBe('cancelled')
    expect(job.error).toBeNull()
    // The cascade reached the child too.
    expect((await store.get(childJobId!))?.status).toBe('cancelled')
    // The loop died where the throw happened: no tool result, no finish.
    expect(trace.results).toEqual([])
    expect(trace.finished).toBe(false)
  })

  it('a child the HOST cancelled directly also kills the loop, instead of coming back as a tool result', async () => {
    // The cascade case above aborts the AGENT's signal, so `signal.aborted`
    // answers before any error code is read. This is the case with only the
    // code to go on: `cancelJob(childJobId)` aborts the child's controller and
    // nothing else, so the parent's signal is clear and the thrown CANCELLED
    // must carry `.code` to reach CHILD_FAILURE_RETHROWN_CODES. A bare
    // `new Error('CANCELLED')` normalises to DISPATCH_EXECUTE_FAILED, the loop
    // is handed SUBAGENT_TOOL_FAILED, and the model is invited to retry work
    // the host just cancelled.
    let releaseChild!: () => void
    const childGate = new Promise<void>((r) => {
      releaseChild = r
    })
    let enteredChild!: () => void
    const childEntered = new Promise<void>((r) => {
      enteredChild = r
    })

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(
      {
        id: 'meta_child',
        kind: 'meta',
        description: 'child the host cancels directly',
        tool: { description: 'run the child', inputs: PROMPT_INPUT },
        outputs: z.object({ ok: z.boolean() }),
        // Parks on the gate, then touches ctx.compute: the abort guard at the
        // top of runWithRetry is what throws once the cancel has landed.
        async compose(_args: { input: unknown }, ctx: ExecutionContext) {
          enteredChild()
          await childGate
          return ctx.compute('after-gate', async () => ({ ok: true }))
        },
      } as unknown as MetaPattern,
    )
    registry.register(callerAgent() as never)
    const trace: LoopTrace = { results: [], finished: false }
    const store = new MemoryJobStore()
    const ids: string[] = []
    const runtime = new InlineRuntime({
      store: store as never,
      registry,
      router: makeRouter(),
      agentRunImpl: makeRunImpl(['go'], trace),
      logger: silentDiagnosticsLogger,
      onJobCreated: (id) => ids.push(id),
    })

    const pending = runtime.submitJob({
      patternId: 'agent_caller',
      input: { prompt: 'start' },
    })
    await childEntered
    // onJobCreated fires per dispatch in creation order: [agent, child].
    expect(ids).toHaveLength(2)
    const [agentJobId, childJobId] = ids

    // Only the CHILD is cancelled — the agent's own controller is untouched.
    await runtime.cancelJob(childJobId!)
    releaseChild()
    const job = await pending

    expect((await store.get(childJobId!))?.status).toBe('cancelled')
    // The loop died where the throw happened: no tool result, no finish.
    expect(trace.results).toEqual([])
    expect(trace.finished).toBe(false)
    // The parent was not cancelled itself, so it fails — carrying the child's
    // code rather than a generic dispatch failure.
    expect(job.id).toBe(agentJobId)
    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('CANCELLED')
  })
})
