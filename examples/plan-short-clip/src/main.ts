// A persisted plan — the whole host.
//
// `src/short-clip.plan.json` is a pipeline written as data: three steps, each
// one a `ctx.step` call spelled `{ id, pattern, input, assets }`, with
// `$`-references between them. `planToMeta` walks it with the registry in hand
// and returns an ordinary `MetaPattern` (see ./pattern.ts). Nothing about the
// runtime knows it is a plan.
//
// The claim this file narrates, in two halves:
//
//   1. A plan gets everything a hand-written meta gets. Change `motion` and
//      re-submit in the same session: `describe` and `render` never read
//      `motion`, so their keys are unchanged and both come back as the rows run
//      1 wrote — same child job id, no model call. That is exactly what
//      examples/incremental-rerun shows for the hand-written twin of this
//      pipeline.
//
//   2. And one thing the hand-written meta does not. Every plan step dispatches
//      with `identity: 'id'`, so its row is keyed by the step's NAME, not by
//      its position in the compose run. Re-author the plan with a step inserted
//      SECOND and all three original steps still hit — one model call for one
//      new step. Under positional identity the same edit would move `render`
//      from index 1 to 2 and `animate` from 2 to 3 and re-run both for nothing.
//
// Mocks only — no API key, no provider SDK. The three ModelCapability envelopes
// in ./mock-models sleep for a few hundred ms each so "instant" is visible next
// to "ran". Nothing below the wiring is more than printing.

import {
  PatternRegistry,
  type PatternId,
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
import { CAPTIONED_PATTERN_ID, createCaptionedShortClip } from './plan-captioned'
import { createShortClip, SHORT_CLIP_PATTERN_ID, SHORT_CLIP_PLAN } from './pattern'

// 1. Register the three atomics the plan steps through. The plan itself is
//    registered after them, because its factory is handed a `getPattern` op
//    that reads this registry — the same channel package.json declares as
//    `"requiredOps": ["getPattern"]`.
const registry = new PatternRegistry()
registry.register(createTextGenerationPattern())
registry.register(createTextToImagePattern())
registry.register(createImageToVideoPattern())

const ops = { getPattern: (id: PatternId) => registry.get(id) }
registry.register(createShortClip(ops))
registry.register(createCaptionedShortClip(ops))

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

const observer = createRunObserver()
const runtime = new InlineRuntime({
  store,
  registry,
  router,
  onJobCreated: observer.onJobCreated,
})

// Dedup never crosses a session boundary, so every run below shares this one.
const SESSION = 'session-demo'

console.log(`
The plan, as data (src/short-clip.plan.json):
${SHORT_CLIP_PLAN.steps
  .map(
    (s) =>
      `  ${s.id.padEnd(10)}${s.pattern.padEnd(18)}` +
      `input ${JSON.stringify(s.input)}` +
      (s.assets ? `  assets ${JSON.stringify(s.assets)}` : ''),
  )
  .join('\n')}
  → returns ${JSON.stringify(SHORT_CLIP_PLAN.output)}`)

// 4. Run 1 — cold. All three steps run; every row is new.
const run1 = await observer.run(
  runtime,
  SHORT_CLIP_PATTERN_ID,
  { prompt: 'a red bicycle', motion: 'slow pan' },
  SESSION,
)
printRun('Run 1 — cold', run1)

// 5. Run 2 — same session, `motion` changed. `describe` and `render` never read
//    `motion` ($input.motion appears only in `animate`), so their keys are
//    unchanged: each comes back as the row run 1 wrote, under the same
//    childJobId, with no model call. `animate` reads `motion`, so it is a new
//    key — but it animates run 1's still, because `render`'s STORED output
//    (asset id and all) is what the interpreter substituted.
const run2 = await observer.run(
  runtime,
  SHORT_CLIP_PATTERN_ID,
  { prompt: 'a red bicycle', motion: 'orbit' },
  SESSION,
)
printRun('Run 2 — same session, motion changed', run2, { label: 'run 1', trace: run1 })

// 6. Run 3 — the plan itself, revised: a `caption` step inserted SECOND. This
//    is the identity:'id' payoff. All three original steps keep their keys,
//    because a key names the step rather than counting to it.
const run3 = await observer.run(
  runtime,
  CAPTIONED_PATTERN_ID,
  { prompt: 'a red bicycle', motion: 'slow pan' },
  SESSION,
)
printRun('Run 3 — a step inserted second', run3, { label: 'run 1', trace: run1 })

console.log(`
What made it work: every plan step dispatches with { stepId: <the DAG's id>, identity: 'id' }, so its
  idempotency key is { patternId, input, assets, sessionId, stepKey } — the step's NAME, not its
  position. Insert a step and the ones that did not change still hit; that is the one thing a plan
  needs that a write-once hand-written meta does not (packages/orchestral-core/src/execution-context.ts,
  StepOptions.identity).
What breaks it: a different sessionId — the key never crosses a session. Error / cancelled / stale rows
  never match either, so a failed step always re-runs. And a changed upstream asset re-keys downstream
  correctly: \`assets\` is in the key, so a re-rendered still is a new \`animate\`.`)

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
 * was inserted for that step's pattern this run — never from a flag the runtime
 * did not send. If the two ever disagreed the cell would say so.
 */
function printRun(
  title: string,
  trace: RunTrace,
  baseline?: { label: string; trace: RunTrace },
): void {
  const { job, steps, inserted, insertedIds } = trace
  const stepTotal = steps.reduce((sum, s) => sum + s.ms, 0)
  console.log(`\n${title}`)
  console.log(
    `  input ${JSON.stringify(job.input)}  →  plan job ${short(job.id)} (${job.status}), ${stepTotal} ms across steps`,
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
    // Asked of the child's own row id, not of its pattern: `describe` and
    // `caption` are both text-generation, so a pattern-keyed answer would
    // report one of them as inserted because the other was.
    const rowInserted = insertedIds.includes(s.childJobId)
    const cached =
      sameId && !rowInserted
        ? `yes — same childJobId as ${baseline.label}, no row inserted`
        : !sameId && rowInserted
          ? 'no  — new childJobId, row inserted'
          : prior === undefined
            ? 'new — this step did not exist in the baseline'
            : `??  — signals disagree (sameId=${sameId}, inserted=${rowInserted})`
    console.log(`${row}${cached}`)
  }
  console.log(`  rows inserted this run: ${inserted.join(', ')}`)
  if (job.output) {
    const values = Object.entries(job.output.values)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ')
    const assets = job.output.assets
      .map((a) => `${a.label}:${a.assetId}`)
      .join(', ')
    console.log(`  output: ${values}`)
    console.log(`          assets [${assets}]  cost ${job.output.cost}`)
  }
}
