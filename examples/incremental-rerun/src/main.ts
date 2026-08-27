// Incremental re-run — the whole host.
//
// The claim: `ctx.step` is content-addressed. Every sub-dispatch inside a meta
// derives an idempotency key from { patternId, input, assets, sessionId,
// stepIndex } (packages/orchestral-runtime/src/idempotency.ts) and goes through
// `JobStore.insertIfAbsent`; a hit returns the existing `done` row instead of
// dispatching. So re-submit the same meta with ONE input changed, in the same
// session, and every step whose inputs did not change comes back instantly
// under the SAME child job id, while the changed step and everything downstream
// of it re-run. ComfyUI's node cache, for code — and nothing was built for it.
// This file only observes.
//
// Mocks only — no API key, no provider SDK. The three ModelCapability
// envelopes in ./mock-models sleep for a few hundred ms each so "instant" is
// visible next to "ran". Nothing below the wiring is more than printing.

import {
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import {
  createImageToVideoPattern,
  createTextGenerationPattern,
  createTextToImagePattern,
} from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createMockModels } from './mock-models'
import { createRunObserver, type RunTrace } from './observe'
import { createShortClipMeta } from './pattern'

// 1. Register the three atomics the meta steps through, plus the meta itself.
const registry = new PatternRegistry()
registry.add(createTextGenerationPattern())
registry.add(createTextToImagePattern())
registry.add(createImageToVideoPattern())
registry.add(createShortClipMeta())

// 2. One mock model per capability, each with an artificial latency. The
//    latency is the only thing that makes a hit look different from a run on
//    the clock; the ids are what prove it.
const { getModels } = createMockModels({
  latencyMs: { 'text-generation': 300, 'text-to-image': 500, 'image-to-video': 400 },
})
const router = createDefaultCapabilityRouter({ getModels })

// 3. One JobStore for the whole demo. It IS the cache: every dedup decision
//    below is `insertIfAbsent` finding a `done` row with the same key.
const store = new InMemoryJobStore()

// 4. Runtime, with the observer's onJobCreated hook — the only place a
//    subscription can be made early enough to see `job:step` (see ./observe).
const observer = createRunObserver()
const runtime = new InlineRuntime({
  store,
  registry,
  router,
  onJobCreated: observer.onJobCreated,
})

// Dedup never crosses a session boundary, so every run below shares this one.
const SESSION = 'session-demo'

// 5. Run 1 — cold. All three steps run; every row is new.
const run1 = await observer.run(
  runtime,
  { prompt: 'a red bicycle', motion: 'slow pan' },
  SESSION,
)
printRun('Run 1 — cold', run1)

// 6. Run 2 — same session, `motion` changed. `describe` and `render` never
//    read `motion`, so their keys are unchanged: each comes back as the row run
//    1 wrote, under the same childJobId, with no model call. `animate` reads
//    `motion`, so it is a new key — but it animates run 1's still, because
//    `render`'s stored output (asset id and all) is what the meta received.
const run2 = await observer.run(
  runtime,
  { prompt: 'a red bicycle', motion: 'orbit' },
  SESSION,
)
printRun('Run 2 — same session, motion changed', run2, { label: 'run 1', trace: run1 })

// 7. Run 3 — `prompt` changed. Step 1 reads it, so step 1 is new; step 2's
//    input is step 1's output, so step 2 is new; step 3's asset is step 2's
//    output, so step 3 is new. Everything downstream of a change re-runs.
const run3 = await observer.run(
  runtime,
  { prompt: 'a blue kettle', motion: 'orbit' },
  SESSION,
)
printRun('Run 3 — prompt changed', run3, { label: 'run 2', trace: run2 })

// 8. "Restart" — a SECOND runtime over the SAME store. The runtime holds no
//    cache of its own; the rows are the cache. A fresh instance that never ran
//    `describe` or `render` still gets run 1's rows back for them. The
//    InMemoryJobStore stands in for the durable JobStore a real host injects —
//    with one of those, this is a process restart. `abandonOrphanedJobs()` is
//    the other half of that story: on start it marks rows a dead process left
//    `queued` / `running` as `stale`, and stale rows never dedupe.
const restarted = new InlineRuntime({
  store,
  registry,
  router,
  onJobCreated: observer.onJobCreated,
})
const orphaned = await restarted.abandonOrphanedJobs()
console.log(`\nSecond runtime over the same store — abandonOrphanedJobs() found ${orphaned.length} row(s) mid-flight`)
const run4 = await observer.run(
  restarted,
  { prompt: 'a red bicycle', motion: 'dolly zoom' },
  SESSION,
)
printRun('Run 4 — second runtime, run 1 prompt, new motion', run4, { label: 'run 1', trace: run1 })

// 9. What made it work, and what breaks it.
console.log(`
What made it work: each ctx.step derives its key from { patternId, input, assets, sessionId, stepIndex }
  (packages/orchestral-runtime/src/idempotency.ts) and goes through JobStore.insertIfAbsent, which hands
  back the existing done row on a hit — no dispatch, same childJobId, the stored output flows downstream.
What breaks it: a different sessionId. The key never crosses a session, so run 1's input in another
  session re-runs all three steps (pinned by the smoke test). Error / cancelled / stale rows never
  match either — a failed step always re-runs — and stepIndex is positional, so reordering compose is a
  new key too.`)

// ── printing ────────────────────────────────────────────────────────────────

/** First 8 hex chars of a job id — enough to tell rows apart on a page. */
function short(id: string): string {
  return id.slice(0, 8)
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/**
 * Print one run as a table. The `cached` column is derived from two runtime
 * signals — the childJobId equals the baseline run's for that step, AND no row
 * was inserted for that step's pattern this run — never from a flag the
 * runtime did not send. If the two ever disagreed the cell would say so.
 */
function printRun(
  title: string,
  trace: RunTrace,
  baseline?: { label: string; trace: RunTrace },
): void {
  const { job, steps, inserted } = trace
  const stepTotal = steps.reduce((sum, s) => sum + s.ms, 0)
  console.log(`\n${title}`)
  console.log(
    `  input ${JSON.stringify(job.input)}  →  meta job ${short(job.id)} (${job.status}), ${stepTotal} ms across steps`,
  )
  const head = `  ${pad('step', 10)}${pad('pattern', 18)}${pad('ms', 7)}${pad('childJobId', 12)}${pad('assets', 10)}`
  console.log(baseline ? `${head}cached` : head)
  for (const s of steps) {
    const row = `  ${pad(s.stepId, 10)}${pad(s.patternId, 18)}${pad(String(s.ms), 7)}${pad(short(s.childJobId), 12)}${pad(s.assetIds.join(','), 10)}`
    if (!baseline) {
      console.log(row)
      continue
    }
    const prior = baseline.trace.steps.find((b) => b.stepId === s.stepId)
    const sameId = prior !== undefined && prior.childJobId === s.childJobId
    const rowInserted = inserted.includes(s.patternId)
    const cached =
      sameId && !rowInserted
        ? `yes — same childJobId as ${baseline.label}, no row inserted`
        : !sameId && rowInserted
          ? 'no  — new childJobId, row inserted'
          : `??  — signals disagree (sameId=${sameId}, inserted=${rowInserted})`
    console.log(`${row}${cached}`)
  }
  console.log(`  rows inserted this run: ${inserted.join(', ')}`)
  if (job.output) {
    console.log(
      `  output: "${job.output.description}" → still ${job.output.frameAssetId} → clip ${job.output.assets.map((a) => a.assetId).join(',')}`,
    )
  }
}
