// Host-side observation — how the demo SEES a dedup hit. The runtime never
// says "cached"; it hands the meta an existing row instead of dispatching, and
// two things on its public surface show that happened:
//
//   • `job:step`, fired on the meta's own stream as each sub-step settles,
//     carries `childJobId` — the sub-dispatch's row id. It fires for a dedup
//     hit too (meta-execution-context.ts calls `onStepSettled` after
//     `submitChild` returns, whichever way it returned), so the SAME id shows
//     up again. Compare ids across runs.
//   • `InlineRuntimeInit.onJobCreated` fires once per row the runtime INSERTs.
//     A dedup hit inserts nothing and does not fire for that child. Count the
//     rows per run.
//
// Plus the wall clock: the time between consecutive `job:step` events. The
// mocks sleep for hundreds of ms; a hit takes about none.
//
// The hook must be handed to the InlineRuntime constructor, and subscribing
// has to happen inside it — `submitJob` resolves only after the job is
// terminal, so a subscription made afterwards observes nothing.

import type { InlineRuntime, InlineRuntimeInit } from '@orchestral/runtime'
import type { Job } from '@orchestral/core'
import {
  SHORT_CLIP_PATTERN_ID,
  type ShortClipInput,
  type ShortClipOutput,
} from './pattern'

export interface StepRecord {
  /** Author-facing stepId, as passed to ctx.step (`describe` / `render` / `animate`). */
  stepId: string
  patternId: string
  /** The sub-dispatch's row id — identical across runs on a dedup hit. */
  childJobId: string
  /** ms between the previous step settling (or the meta starting) and this one. */
  ms: number
  /** Asset ids the step's output carried, from the event's `assets`. */
  assetIds: readonly string[]
}

export interface RunTrace {
  job: Job<ShortClipInput, ShortClipOutput>
  /** One record per `job:step` on the meta's stream, in settle order. */
  steps: readonly StepRecord[]
  /** patternId of every row the runtime INSERTed during the run, in order. */
  inserted: readonly string[]
}

export interface RunObserver {
  /** Pass as `InlineRuntimeInit.onJobCreated`. */
  onJobCreated: NonNullable<InlineRuntimeInit['onJobCreated']>
  /** Submit one meta dispatch and collect what the runtime reported about it. */
  run(runtime: InlineRuntime, input: ShortClipInput, sessionId: string): Promise<RunTrace>
}

export function createRunObserver(): RunObserver {
  let runtime: InlineRuntime | undefined
  let pending: { steps: StepRecord[]; inserted: string[] } | undefined

  const onJobCreated: RunObserver['onJobCreated'] = (jobId, spec) => {
    if (!pending || !runtime) return
    pending.inserted.push(spec.patternId)
    if (spec.patternId !== SHORT_CLIP_PATTERN_ID) return
    const { steps } = pending
    let prev = Date.now()
    runtime.subscribe(jobId, (ev) => {
      if (ev.type === 'job:started') prev = Date.now()
      if (ev.type !== 'job:step') return
      const now = Date.now()
      steps.push({
        stepId: ev.stepId,
        patternId: ev.patternId,
        childJobId: ev.childJobId,
        ms: now - prev,
        assetIds: (ev.assets ?? []).map((a) => a.assetId),
      })
      prev = now
    })
  }

  return {
    onJobCreated,
    async run(rt, input, sessionId) {
      runtime = rt
      const current = { steps: [] as StepRecord[], inserted: [] as string[] }
      pending = current
      try {
        const job = await rt.submitJob<ShortClipInput, ShortClipOutput>({
          patternId: SHORT_CLIP_PATTERN_ID,
          input,
          sessionId,
        })
        return { job, steps: current.steps, inserted: current.inserted }
      } finally {
        pending = undefined
      }
    },
  }
}
