// Host-side observation — how the demo SEES a dedup hit. The runtime never
// says "cached"; it hands the plan an existing row instead of dispatching, and
// two things on its public surface show that happened:
//
//   • `job:step`, fired on the plan's own stream as each step settles, carries
//     `childJobId` — the sub-dispatch's row id. It fires for a dedup hit too,
//     so the SAME id shows up again. Compare ids across runs.
//   • `InlineRuntimeInit.onJobCreated` fires once per row the runtime INSERTs.
//     A dedup hit inserts nothing and does not fire for that child. Count the
//     rows per run.
//
// Plus the wall clock: the time between consecutive `job:step` events. The
// mocks sleep for hundreds of ms; a hit takes about none.
//
// The hook must be handed to the InlineRuntime constructor, and subscribing has
// to happen inside it — `submitJob` resolves only after the job is terminal, so
// a subscription made afterwards observes nothing.

import type { Job, PatternId, PlanOutput } from '@orchestral/core'
import type { InlineRuntime, InlineRuntimeInit } from '@orchestral/runtime'

import type { ShortClipInput } from './pattern'

export interface StepRecord {
  /** The plan step's own id (`describe` / `render` / `animate`), as written in
   *  the DAG and passed to `ctx.step` as `options.stepId`. */
  stepId: string
  patternId: string
  /** The sub-dispatch's row id — identical across runs on a dedup hit. */
  childJobId: string
  /** ms between the previous step settling (or the plan starting) and this one. */
  ms: number
  /** Asset ids the step's output carried, from the event's `assets`. */
  assetIds: readonly string[]
}

export interface RunTrace {
  job: Job<ShortClipInput, PlanOutput>
  /** One record per `job:step` on the plan's stream, in settle order. */
  steps: readonly StepRecord[]
  /** patternId of every row the runtime INSERTed during the run, in order. */
  inserted: readonly string[]
  /**
   * The job ids of those same rows. Pattern ids alone stop being a per-step
   * signal the moment two steps share a pattern (`describe` and `caption` are
   * both text-generation), so "was a row inserted for THIS step" has to be
   * asked of the child's own id.
   */
  insertedIds: readonly string[]
}

export interface RunObserver {
  /** Pass as `InlineRuntimeInit.onJobCreated`. */
  onJobCreated: NonNullable<InlineRuntimeInit['onJobCreated']>
  /** Submit one plan dispatch and collect what the runtime reported about it. */
  run(
    runtime: InlineRuntime,
    patternId: PatternId,
    input: ShortClipInput,
    sessionId: string,
  ): Promise<RunTrace>
}

export function createRunObserver(): RunObserver {
  let runtime: InlineRuntime | undefined
  let pending:
    | {
        steps: StepRecord[]
        inserted: string[]
        insertedIds: string[]
        rootId?: string
      }
    | undefined

  const onJobCreated: RunObserver['onJobCreated'] = (jobId, spec) => {
    if (!pending || !runtime) return
    pending.inserted.push(spec.patternId)
    pending.insertedIds.push(jobId)
    // The FIRST row created in a run is the plan job itself; every later one is
    // a step of it. Keying on that rather than on a pattern id keeps this
    // observer usable for both plan patterns the demo registers.
    if (pending.rootId !== undefined) return
    pending.rootId = jobId
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
    async run(rt, patternId, input, sessionId) {
      runtime = rt
      const current = {
        steps: [] as StepRecord[],
        inserted: [] as string[],
        insertedIds: [] as string[],
      }
      pending = current
      try {
        const job = await rt.submitJob<ShortClipInput, PlanOutput>({
          patternId,
          input,
          sessionId,
        })
        return {
          job,
          steps: current.steps,
          inserted: current.inserted,
          insertedIds: current.insertedIds,
        }
      } finally {
        pending = undefined
      }
    },
  }
}
