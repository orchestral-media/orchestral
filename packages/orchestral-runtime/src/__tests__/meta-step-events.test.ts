// A meta pipeline is ONE Job to its caller: the sub-dispatches it runs have
// their own ids the caller never sees. `job:step` is what makes a long chain
// (image → video → speech) observable while it runs, instead of silent from
// job:started until the whole thing settles.
//
// Driven through the real `buildMetaExecutionContext` + `ctx.step` path, so
// this pins the emit at its actual site rather than a faked callback.

import { describe, expect, it } from 'vitest'

import type { Job, JobSpec, PatternId } from '@orchestral/core'

import { silentDiagnosticsLogger, InMemoryJobStore, PatternRegistry } from '@orchestral/core'
import type {
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  MetaPattern,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'
import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
} from '../meta-execution-context'

type Settled = {
  rootJobId: string
  stepId: string
  patternId: PatternId
  childJobId: string
  output: unknown
}

/** A child job that succeeded, carrying whatever output the test wants. */
function doneChild(id: string, output: unknown): Job {
  return {
    id,
    patternId: 'x' as PatternId,
    idempotencyKey: id,
    status: 'done',
    input: {},
    output,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  } as Job
}

function makeCtx(settled: Settled[], childOutputs: Record<string, unknown>) {
  let n = 0
  const deps: MetaCtxDeps = {
    submitChild: async (spec) => {
      const childId = `child-${n++}`
      return doneChild(childId, childOutputs[spec.patternId] ?? { ok: true }) as never
    },
    onStepSettled: (args) => settled.push(args as Settled),
  }
  const state = makeFreshState()
  state.rootJobId = 'root-1'
  const spec = { patternId: 'meta_demo' as PatternId, input: {} } as JobSpec<unknown>
  return buildMetaExecutionContext(
    deps,
    'meta_demo' as PatternId,
    'root-1',
    spec,
    new AbortController().signal,
    new Set<PatternId>(),
    state,
  )
}

describe('job:step — meta sub-steps on the parent stream', () => {
  it('reports each dispatched step with its author-facing id and child job id', async () => {
    const settled: Settled[] = []
    const ctx = makeCtx(settled, {})

    await ctx.step({ patternId: 'text-to-image' as PatternId, input: {} }, { stepId: 'render' })
    await ctx.step({ patternId: 'image-to-video' as PatternId, input: {} }, { stepId: 'animate' })

    expect(settled.map((s) => s.stepId)).toEqual(['render', 'animate'])
    expect(settled.map((s) => s.patternId)).toEqual(['text-to-image', 'image-to-video'])
    // Correlatable against the store, and distinct per step.
    expect(new Set(settled.map((s) => s.childJobId)).size).toBe(2)
    expect(settled.every((s) => s.rootJobId === 'root-1')).toBe(true)
  })

  it('carries the media a step produced, so an intermediate frame is showable', async () => {
    const settled: Settled[] = []
    const ctx = makeCtx(settled, {
      'text-to-image': {
        modality: 'image',
        assets: [{ assetId: 'ast_1', modality: 'image', url: 'data:image/png;base64,AA' }],
      },
    })

    await ctx.step({ patternId: 'text-to-image' as PatternId, input: {} }, { stepId: 'render' })

    expect(settled).toHaveLength(1)
    expect(settled[0]!.output).toMatchObject({
      assets: [{ assetId: 'ast_1', modality: 'image' }],
    })
  })

  it('stays silent for ctx.compute — no sub-dispatch, nothing to correlate', async () => {
    const settled: Settled[] = []
    const ctx = makeCtx(settled, {})

    await ctx.compute('merge', async () => 42)

    expect(settled).toEqual([])
  })

  it('reports a step exactly once, because a repeated step id is rejected', async () => {
    const settled: Settled[] = []
    const ctx = makeCtx(settled, {})
    const ref = { patternId: 'text-to-image' as PatternId, input: { prompt: 'a' } }

    await ctx.step(ref, { stepId: 'render' })
    // The guard is what makes "exactly once" true — there is no second
    // arrival to suppress, so nothing can double-count.
    await expect(ctx.step(ref, { stepId: 'render' })).rejects.toThrow('DUPLICATE_STEP_ID')

    expect(settled).toHaveLength(1)
  })
})

describe('job:step — end to end through InlineRuntime', () => {
  it('reaches a subscriber as each step lands, before the pipeline completes', async () => {
    const IMAGE_OUT = z.object({
      modality: z.literal('image'),
      assets: z.array(
        z.object({ assetId: z.string().max(64), modality: z.string().max(16) }),
      ),
    })
    const atomic = {
      id: 'text-to-image',
      kind: 'atomic',
      description: 'render',
      exposure: 'agent-tool',
      outputs: IMAGE_OUT,
      primary: { tool: { description: 'render', inputs: z.object({ prompt: z.string() }) } },
    } as unknown as AtomicPattern

    let n = 0
    const model = {
      modelId: 'm',
      provider: 'fake',
      tags: [] as never[],
      capabilities: [] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['image'] as Modality[],
      source: 'user' as const,
      async call() {
        return {
          output: { modality: 'image', assets: [{ assetId: `ast_${n++}`, modality: 'image' }] },
        }
      },
    } as unknown as ModelCapability
    const router: CapabilityRouter = {
      checkSatisfiable: () => ({ ok: true, candidates: [model] }),
      resolve: () => model,
    }

    const meta = {
      id: 'meta_two_shots',
      kind: 'meta',
      description: 'render two shots',
      tool: { description: 'two shots', inputs: z.object({}) },
      outputs: z.object({ count: z.number() }),
      compose: async (_input: unknown, ctx: never) => {
        const c = ctx as unknown as {
          step: (ref: unknown, o: unknown) => Promise<{ value: unknown }>
        }
        await c.step({ patternId: 'text-to-image', input: { prompt: 'shot 1' } }, { stepId: 'shot-1' })
        await c.step({ patternId: 'text-to-image', input: { prompt: 'shot 2' } }, { stepId: 'shot-2' })
        return { count: 2 }
      },
    } as unknown as MetaPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(atomic)
    registry.register(meta)

    const events: JobEvent[] = []
    const rt = new InlineRuntime({
      store: new InMemoryJobStore() as never,
      registry,
      router,
      onJobCreated: (jobId, spec) => {
        if (spec.patternId === 'meta_two_shots') {
          rt.subscribe(jobId, (ev) => events.push(ev))
        }
      },
    })

    const job = await rt.submitJob({ patternId: 'meta_two_shots', input: {} })
    expect(job.status).toBe('done')

    const steps = events.filter((e) => e.type === 'job:step')
    expect(steps).toHaveLength(2)
    const first = steps[0]!
    if (first.type !== 'job:step') throw new Error('unreachable')
    expect(first.stepId).toBe('shot-1')
    expect(first.patternId).toBe('text-to-image')
    // The intermediate image is on the event — that is the point of it.
    expect(first.assets).toEqual([{ assetId: 'ast_0', modality: 'image' }])

    // Ordering: both steps are visible before the pipeline reports completion.
    const types = events.map((e) => e.type)
    expect(types.lastIndexOf('job:step')).toBeLessThan(types.indexOf('job:completed'))
  })
})
