// Abort-signal cascade + independent-agent opt-out regression.
//
// Cancellation is COOPERATIVE: cancelJob does not kill the provider call, it
// aborts that job's AbortController, and dispatch checks signal.aborted at
// every await boundary (the pre/post guards in inline.ts `_submitJobInternal`
// plus every hop of the fallback walk) before it throws CANCELLED. A child
// job's controller subscribes to the parent signal, so a parent cancel
// cascades down; an agent child job with abortMode:'independent' does not
// subscribe — it stays alive after the parent exits and can be re-attached via
// resumeFromRunId.
//
// This path is the safety valve for long-running media workflows: without it a
// user cancel leaves orphaned child agents burning provider tokens. Nothing
// covered it before this file — the handful of `new AbortController().signal`
// occurrences in fork-context / meta-step-references are placeholder
// arguments, and not one of them actually triggers a cancel.
//
// Mechanism: a controllable gate promise suspends cap.call / agentRunImpl.run
// so the job reaches `running` → cancelJob → release the gate → dispatch
// resumes and hits a guard. jobIds are captured through the constructor-level
// onJobCreated hook (which also fires for every child dispatch, parent before
// child).

import { describe, expect, it } from 'vitest'

import type {
  AgentPattern,
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  MetaPattern,
  ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'
import type { AgentRunImpl } from '../agent-run'

// A deferred we can resolve from the test to suspend/release a dispatch.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Router whose capability call runs `onEnter` then awaits `gate` before
// returning — lets the test observe "job is in flight" and hold it there.
function makeGatedRouter(onEnter: () => void, gate: Promise<void>): CapabilityRouter {
  const cap: ModelCapability = {
    modelId: 'fake:gated',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-gated'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call(input: unknown) {
      onEnter()
      await gate
      const inp = input as { prompt?: string }
      return {
        output: { modality: 'image', assetId: 'img-0', prompt: inp.prompt ?? '' },
      } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function makeInstantRouter(): CapabilityRouter {
  const cap: ModelCapability = {
    modelId: 'fake:instant',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-instant'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call() {
      return { output: { modality: 'image', assetId: 'img-0', prompt: '' } } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function fakeAtomic(id: string): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id,
    kind: 'atomic',
    description: 'fake atomic',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'a', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

// Parent meta that dispatches one child pattern via ctx.step — the meta's
// controller.signal becomes the child's parentSignal, so cancelling the parent
// cascades into the child (unless the child opts out).
function cascadeParent(childPatternId: string): MetaPattern<Record<string, never>, unknown> {
  return {
    id: 'meta_cascade_parent',
    kind: 'meta',
    description: 'parent that dispatches one child',
    outputs: z.any() as never,
    tool: { description: 'p', inputs: z.object({}) },
    async compose(_params, ctx) {
      const r = await ctx.step({ patternId: childPatternId, input: { prompt: 'child' } })
      return { r }
    },
  }
}

describe('abort cascade', () => {
  it('cancelJob marks a running job cancelled, emits job:cancelled, and settles the submit as cancelled', async () => {
    const store = new MemoryJobStore()
    const entered = deferred()
    const gate = deferred()
    let createdId: string | undefined
    const runtime = new InlineRuntime({
      router: makeGatedRouter(entered.resolve, gate.promise),
      registry: (() => {
        const r = new PatternRegistry()
        r.add(fakeAtomic('gated') as never)
        return r
      })(),
      store: store as never,
      onJobCreated: (id) => {
        createdId ??= id
      },
    })

    const p = runtime.submitJob({ patternId: 'gated', input: { prompt: 'x' } } as never)
    await entered.promise // cap.call entered → job is running
    expect(createdId).toBeTruthy()

    const events: JobEvent['type'][] = []
    const unsub = runtime.subscribe(createdId!, (ev) => events.push(ev.type))

    await runtime.cancelJob(createdId!)
    // cancelJob writes the terminal status itself — observable immediately.
    expect((await store.get(createdId!))?.status).toBe('cancelled')

    gate.resolve() // let the suspended dispatch resume into the abort guard
    const settled = await p
    expect(settled.status).toBe('cancelled')
    expect(settled.error).toBeNull()
    expect(events).toContain('job:cancelled')
    unsub()
  })

  it('cancelJob rejects JOB_NOT_FOUND for an unknown id', async () => {
    const runtime = new InlineRuntime({
      router: makeInstantRouter(),
      registry: (() => {
        const r = new PatternRegistry()
        r.add(fakeAtomic('instant') as never)
        return r
      })(),
      store: new MemoryJobStore() as never,
    })
    await expect(runtime.cancelJob('does-not-exist')).rejects.toThrow(/JOB_NOT_FOUND/)
  })

  it('cancelJob rejects JOB_ALREADY_TERMINAL for a completed job', async () => {
    const runtime = new InlineRuntime({
      router: makeInstantRouter(),
      registry: (() => {
        const r = new PatternRegistry()
        r.add(fakeAtomic('instant') as never)
        return r
      })(),
      store: new MemoryJobStore() as never,
    })
    const job = await runtime.submitJob({ patternId: 'instant', input: { prompt: 'x' } } as never)
    expect(job.status).toBe('done')
    await expect(runtime.cancelJob(job.id)).rejects.toThrow(/JOB_ALREADY_TERMINAL/)
  })

  it('cancelling a parent meta cascades to its in-flight child (W-18)', async () => {
    const store = new MemoryJobStore()
    const entered = deferred()
    const gate = deferred()
    const ids: string[] = []
    const registry = new PatternRegistry()
    registry.add(fakeAtomic('gated') as never)
    registry.add(cascadeParent('gated') as never)
    const runtime = new InlineRuntime({
      router: makeGatedRouter(entered.resolve, gate.promise),
      registry,
      store: store as never,
      onJobCreated: (id) => ids.push(id),
    })

    const p = runtime.submitJob({ patternId: 'meta_cascade_parent', input: {} } as never)
    await entered.promise // the child's cap.call is in flight
    // onJobCreated fires per sub-dispatch in creation order: [parent, child].
    expect(ids.length).toBe(2)
    const [parentId, childId] = ids

    await runtime.cancelJob(parentId)
    expect((await store.get(parentId))?.status).toBe('cancelled')

    gate.resolve()
    expect((await p).status).toBe('cancelled') // parent settles cancelled

    // The child's controller was subscribed to the parent's signal, so the
    // cascade aborted it too — it ends 'cancelled', not 'done'.
    expect((await store.get(childId))?.status).toBe('cancelled')
  })

  it('an abortMode=independent agent child is NOT cascaded — it survives the parent cancel (W-19)', async () => {
    const store = new MemoryJobStore()
    const entered = deferred()
    const gate = deferred()
    const ids: string[] = []

    const independentAgent: AgentPattern = {
      id: 'agent_independent',
      kind: 'agent',
      description: 'independent agent — opts out of the parent abort cascade',
      primary: { tool: { description: 'a', inputs: z.object({ prompt: z.string() }) } },
      loop: {
        system: 'test',
        toolPatternIds: [],
        modelTags: [],
        abortMode: 'independent',
      },
    } as unknown as AgentPattern

    // Gated run impl: signals entry, then waits — held in flight while we cancel
    // the parent. Finishes via the injected finish tool once released.
    const agentRunImpl = {
      async run(args: Parameters<AgentRunImpl['run']>[0]) {
        entered.resolve()
        await gate.promise
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'done', deliverables: [] },
          callId: 'finish',
        })
        return { text: 'done' }
      },
    } as unknown as AgentRunImpl

    const registry = new PatternRegistry()
    registry.add(independentAgent as never)
    registry.add(cascadeParent('agent_independent') as never)
    const runtime = new InlineRuntime({
      router: makeInstantRouter(),
      registry,
      store: store as never,
      agentRunImpl,
      onJobCreated: (id) => ids.push(id),
    })

    const p = runtime.submitJob({ patternId: 'meta_cascade_parent', input: {} } as never)
    await entered.promise
    expect(ids.length).toBe(2)
    const [parentId, childId] = ids

    await runtime.cancelJob(parentId)
    expect((await store.get(parentId))?.status).toBe('cancelled')

    gate.resolve()
    expect((await p).status).toBe('cancelled') // parent still settles cancelled

    // The independent agent never subscribed to the parent's signal, so its
    // controller was never aborted — it runs to completion as 'done'.
    expect((await store.get(childId))?.status).toBe('done')
  })
})
