// consented-fallback — the whole host.
//
// The user wants to edit an image. The catalog has a text-to-image model and
// an image-to-text model and NO image-to-image model. Four things happen, in
// order, each one something the library does about that gap:
//
//   1. explain  — `router.explain` says why image-to-image has no model.
//   2. refuse   — the default runtime fails the dispatch and NAMES the declared
//                 fallback it did not take, with what that path would lose.
//   3. ask      — a tiny meta (./consented-edit) puts that fallback to the
//                 user; on yes it takes it by hand, on no it stops.
//   4. auto     — a second runtime, built with `alternatives: 'auto'`, takes
//                 the path on its own and announces the degradation as an event.
//
// Runs offline by default: the two models are `ai/test` mocks (./mocks), so
// the narrative records without a key. `--live` (`pnpm start:live`) swaps in
// real OpenAI models behind the OPENAI_API_KEY gate; nothing else changes.
// `SOURCE_IMAGE=/path/to/picture.png` replaces the embedded 1x1 source.

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  AskUserConfirmPayloadSchema,
  formatRoutingExplanation,
  PatternRegistry,
  type Alternative,
  type AskUserConfirmAnswer,
  type AskUserHandler,
  type Job,
  type JobEvent,
  type JobSpec,
  type ResolvedAssetRef,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
import {
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createTextToImagePattern,
  IMAGE_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_TEXT_PATTERN_ID,
  TEXT_TO_IMAGE_PATTERN_ID,
  type ImageToImageInput,
  type ImageToImageOutput,
} from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createModels, type HostModels } from './ai-sdk-wiring'
import { HostAssetStore, type StoredAsset } from './asset-store'
import {
  CONSENTED_EDIT_PATTERN_ID,
  createConsentedEditPattern,
  spellOut,
  type ConsentedEditInput,
  type ConsentedEditOutput,
} from './consented-edit'
import { mockModels, PNG_B64 } from './mocks'

const live = process.argv.includes('--live')
if (live && !process.env.OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI_API_KEY.\n' +
      'Export a key first, e.g.  export OPENAI_API_KEY=sk-...\n' +
      '(no key? run `pnpm --filter consented-fallback start` — the same ' +
      'narrative on mock models, no key needed.)',
  )
  process.exit(1)
}

const EDIT = 'make it night, keep the bicycle'

// ── Host state ──────────────────────────────────────────────────────────────

// The picture the user wants to edit, seeded into the host's asset store under
// an id. From here on the packages only ever see the id.
const assets = new HostAssetStore()
const SOURCE: ResolvedAssetRef = {
  slot: 'source',
  assetId: assets.put('upload-1', loadSourceImage()),
  modality: 'image',
}

function loadSourceImage(): StoredAsset {
  const path = process.env.SOURCE_IMAGE
  if (!path) return { mime: 'image/png', base64: PNG_B64 }
  const ext = extname(path).slice(1).toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`
  return { mime, base64: readFileSync(path).toString('base64') }
}

// The two models. Live: the provider SDK is imported only on this branch, so
// the default run provably never touches it.
async function liveModels(): Promise<HostModels> {
  const { openai } = await import('@ai-sdk/openai')
  return {
    image: { provider: 'openai', modelId: 'gpt-image-1', model: openai.image('gpt-image-1') },
    caption: { provider: 'openai', modelId: 'gpt-4o', model: openai('gpt-4o') },
  }
}
const models = live ? await liveModels() : mockModels()

// ── 1. Registry ─────────────────────────────────────────────────────────────
// The three atomics, the shipped fallback target, and this example's meta.
// `createImageToImagePattern()` carries the `via-caption` Alternative; `add`
// strips it into the registry's alternatives table, which is where the
// runtime (and this host) read it from.
const registry = new PatternRegistry()
registry.register(createTextToImagePattern())
registry.register(createImageToTextPattern())
registry.register(createImageToImagePattern())
registry.register(createImageToImageViaCaptionPattern())

const declared = registry.getEntry(IMAGE_TO_IMAGE_PATTERN_ID)?.alternatives ?? []
const viaCaption = declared.find((alt) => alt.id === 'via-caption') as
  | Alternative<ImageToImageInput, ImageToImageOutput>
  | undefined
if (!viaCaption) throw new Error('image-to-image no longer declares via-caption')
registry.register(createConsentedEditPattern({ path: viaCaption }))

// ── 2. Router ───────────────────────────────────────────────────────────────
// `getModels` answers for text-to-image and image-to-text, and `[]` for
// anything else — there is no image-to-image entry to leave out.
const router = createDefaultCapabilityRouter({
  getModels: createModels(models, assets),
})

// ── 3. Two runtimes, one switch apart ───────────────────────────────────────
// Both subscribe from `onJobCreated`: the inline runtime has already settled
// by the time `submitJob` resolves, so that hook is the only place to watch
// a job from. `askUser` is the host HITL seam — a question on stdin here.

const strict: InlineRuntime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router,
  askUser: askOnStdin,
  onJobCreated: (jobId) => {
    strict.subscribe(jobId, narrate)
  },
})

const degrading: InlineRuntime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router,
  alternatives: 'auto',
  onJobCreated: (jobId) => {
    degrading.subscribe(jobId, narrate)
  },
})

/**
 * `submitJob` resolves with the terminal row either way: a dispatch that ran
 * and failed is data (`status: 'error'`, the `JobError` on the row, `job:failed`
 * already fanned out). It rejects only for a request that never became a job —
 * an unregistered patternId, an input no idempotency key can be derived from.
 */
function submit<TIn, TOut>(
  runtime: InlineRuntime,
  spec: JobSpec<TIn>,
): Promise<Job<TIn, TOut>> {
  return runtime.submitJob<TIn, TOut>(spec)
}

/** The events worth a line: a redirect, and each sub-step as it settles. */
function narrate(ev: JobEvent): void {
  switch (ev.type) {
    case 'job:alternative-selected':
      console.log(
        `  event job:alternative-selected — ${ev.alternativeId} -> ${ev.targetPatternId}`,
      )
      console.log(`    keeps: ${spellOut(ev.preserves)}. loses: ${spellOut(ev.losses)}.`)
      break
    case 'job:step':
      // Fired on the ROOT job's stream for every sub-step in the tree, so a
      // nested chain (consented-edit → via-caption → caption → render) is
      // visible from the one job the caller submitted.
      console.log(
        `  step ${ev.patternId} settled${ev.assets ? ` -> ${ev.assets.length} asset(s)` : ''}`,
      )
      break
    default:
      break
  }
}

/**
 * Host HITL seam. The runtime hands over an `AskUserRequest`; `kind` names
 * the interaction and the payload/answer shapes per kind are the schemas in
 * core's ask-user.ts. This host renders `confirm` on the terminal and reads
 * one line; a closed stdin (no TTY, nothing piped) reads as "no".
 */
async function askOnStdin(
  request: Parameters<AskUserHandler>[0],
): Promise<AskUserConfirmAnswer> {
  if (request.kind !== 'confirm') {
    throw new Error(`this host only answers 'confirm' asks (got '${request.kind}')`)
  }
  const { title, body } = AskUserConfirmPayloadSchema.parse(request.payload)
  console.log(`  ? ${title}`)
  for (const line of (body ?? '').split('\n')) console.log(`    ${line}`)
  const answer = await readLine('    [y/N] ')
  // A piped or closed stdin is not echoed, so the prompt line needs closing.
  if (!process.stdin.isTTY) process.stdout.write('\n')
  const confirmed = /^y(es)?$/i.test((answer ?? '').trim())
  console.log(`  -> ${confirmed ? 'yes' : 'no'}${answer === null ? ' (stdin closed)' : ''}`)
  return { confirmed }
}

async function readLine(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await Promise.race([
      rl.question(prompt),
      new Promise<null>((resolve) => rl.once('close', () => resolve(null))),
    ])
  } finally {
    rl.close()
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`)
}

function preview(assetId: string): string {
  const uri = assets.dataUri(assetId)
  return `${assetId} — ${uri.length > 64 ? `${uri.slice(0, 64)}…` : uri}`
}

// ── The narrative ───────────────────────────────────────────────────────────

console.log(
  `consented-fallback — the user wants to edit a picture ("${EDIT}"), and the catalog has no image-to-image model.`,
)
for (const cap of [TEXT_TO_IMAGE_PATTERN_ID, IMAGE_TO_TEXT_PATTERN_ID, IMAGE_TO_IMAGE_PATTERN_ID]) {
  // `explain` is data: the same screening `resolve` runs, with nothing called.
  const outcome = router.explain?.(cap)?.outcome
  console.log(
    `  ${cap.padEnd(14)} ${outcome?.kind === 'selected' ? `${outcome.model} (by ${outcome.by})` : `no model (${outcome?.kind === 'no-candidate' ? outcome.reason : 'unknown'})`}`,
  )
}

section('1. explain — why image-to-image has no model')
const explanation = router.explain?.(IMAGE_TO_IMAGE_PATTERN_ID)
console.log(explanation ? formatRoutingExplanation(explanation) : '(router has no explain)')

section('2. default — the runtime refuses, and names the path it did not take')
const refused = await submit<ImageToImageInput, ImageToImageOutput>(strict, {
  patternId: IMAGE_TO_IMAGE_PATTERN_ID,
  input: { prompt: EDIT },
  assets: [SOURCE],
})
console.log(`submitJob(${IMAGE_TO_IMAGE_PATTERN_ID}) -> status=${refused.status} code=${refused.error?.code}`)
// `details.diagnostic` is the structured half of the failure: the capability,
// why it is unavailable, and every declared path that would have applied —
// each with what it keeps and loses, so the trade-off can be put to a user
// straight off the refusal.
const diagnostic = (refused.error?.details as { diagnostic?: RefusalDiagnostic } | undefined)
  ?.diagnostic
if (diagnostic) {
  console.log(
    `  reason: ${diagnostic.reason} — ${diagnostic.alternatives.length} declared path(s) would have applied, none taken:`,
  )
  for (const alt of diagnostic.alternatives) {
    console.log(`    ${alt.id} -> ${alt.targetPatternId}`)
    console.log(`      keeps: ${spellOut(alt.preserves)}. loses: ${spellOut(alt.losses)}.`)
  }
  console.log(`  hint: ${diagnostic.hint}`)
}

section('3. ask — a meta puts the trade-off to a human before taking it')
console.log(`submitJob(${CONSENTED_EDIT_PATTERN_ID})`)
const consented = await submit<ConsentedEditInput, ConsentedEditOutput>(strict, {
  patternId: CONSENTED_EDIT_PATTERN_ID,
  input: { prompt: EDIT },
  assets: [SOURCE],
})
if (consented.status !== 'done' || !consented.output) {
  console.error(`Consented edit did not complete: status=${consented.status}`, consented.error)
  process.exit(1)
}
const edit = consented.output
console.log(`status=${consented.status} outcome=${edit.outcome} degraded=${edit.degraded}`)
for (const asset of edit.assets) console.log(`  ${preview(asset.assetId)}`)
if (edit.outcome === 'declined') console.log('  nothing was dispatched')

section("4. auto — a second runtime, built with alternatives: 'auto'")
console.log(`submitJob(${IMAGE_TO_IMAGE_PATTERN_ID})`)
const auto = await submit<ImageToImageInput, ImageToImageOutput>(degrading, {
  patternId: IMAGE_TO_IMAGE_PATTERN_ID,
  input: { prompt: EDIT },
  assets: [SOURCE],
})
if (auto.status !== 'done' || !auto.output) {
  console.error(`Auto redirect did not complete: status=${auto.status}`, auto.error)
  process.exit(1)
}
console.log(`status=${auto.status} via ${auto.output.model}`)
for (const asset of auto.output.assets) console.log(`  ${preview(asset.assetId)}`)
console.log(
  '  the output is image-to-image\'s own shape; the degradation travelled on the event above, not in it',
)

/** The `ALTERNATIVES_NOT_ENABLED` diagnostic, as it reaches `JobError.details`. */
interface RefusalDiagnostic {
  capability: string
  reason: string
  alternatives: readonly {
    id: string
    description: string
    targetPatternId: string
    preserves?: readonly string[]
    losses?: readonly string[]
  }[]
  hint: string
}
