# Changelog

All notable changes to `@orchestral/patterns` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-21 — Initial public release

First public release. `@orchestral/patterns` is the first-party Pattern catalog
for Orchestral: atomic capability patterns and composed meta pipelines, with
their prompts inlined and their inputs/outputs zod-typed. It calls no provider
SDK — every model call goes through the `ModelCapability` your host registers.
Agent-kind patterns are not part of this catalog; they ship in the optional
`@orchestral/agent`, which composes this catalog by pattern id.

### Added

- **Ten atomic capability patterns.** `text-to-image`, `image-to-image`,
  `image-to-text`, `text-to-video`, `image-to-video`, `video-to-video`,
  `text-to-speech`, `text-to-audio`, `automatic-speech-recognition`, and
  `text-generation` — one pattern per capability, each a thin typed envelope
  over the resolved model call.

- **Eight meta pipelines.** Four composed deliverables (explainer short,
  product ad short, product photo pack, UGC testimonial) alongside the
  planning and utility pipelines they and your own metas build on
  (storyboard, script-to-video, best-of-N image selection, and the
  `via-caption` image-edit fallback — the only `Alternative` target in the
  catalog).

- **The catalog is these eight, on purpose.** The long-form novel → video
  pipeline — `meta_script-planning`, `meta_prose-chunking`,
  `meta_novel-to-events`, `meta_event-to-script`, `meta_idea2video`, and the
  `agent_long-form-video` director that was their only consumer — is not in
  the package. It lives, unchanged and with its tests, in
  `examples/long-form-video`: a host that registers the six from its own
  source next to this catalog. Two more metas (`meta_lyrics-to-mv`,
  `meta_reference-image-cascade`) were dropped outright. The reason is surface
  area: every inlined prompt on a published API is a maintenance liability and
  a PR magnet, and those six were one pipeline with one consumer. What ships is
  what a host composes.

- **Typed pattern functions.** `textGeneration`, `textToImage`, `imageToText`,
  `textToSpeech`, `textToAudio`, `imageToVideo`, `imageToImage`,
  `automaticSpeechRecognition`, `imageBestOfNMeta`, and
  `script2videoMeta` give compile-time-checked meta composition; every
  first-party meta dispatches its sub-patterns through them rather than through
  stringly-typed `ctx.step` refs. `ImageGenerationParams` and
  `AsrTranscriptionParams` are exported as the documented host-read top-level
  param channels for machine-to-machine sub-steps.

- **Prompt overrides.** Every prompt-using meta factory accepts an optional
  `prompts?: Partial<…>` (per-meta `*PromptOverrides` types), resolved once at
  factory time. The shipped defaults are exported per meta as frozen
  `*_DEFAULT_PROMPTS` objects, so you extend the wording instead of forking the
  pattern. Metas that share the storyboard design prompt override it
  independently.

- **Uniform cost envelope.** Every meta output carries `cost` / `latencyMs`
  (aggregated across sub-steps, `null` if any sub-step left its cost
  unreported; wall-clock compose time), so a generic consumer can rely on those
  fields on any dispatch.

- **Uniform `assets[]` + `label` envelope on every media-producing meta.**
  Every meta that produces media returns one flat top-level `assets[]` — the
  same `{ assetId, modality, url?, cost? }` element the atomics produce, plus
  a required `label` naming the role the asset played: `final-video` on every
  pipeline that ends in a video, `music`, `hero`, `voiceover`, `shot-<i>`,
  `scene-<i>-image` / `scene-<i>-vo`, `panel-<i>`, and `winner` / `candidate`
  (best-of-n keeps submission order, so `assets[i]` is still candidate `i`).
  No other output field carries an asset id, nested or not. The reason is the
  model-facing projection: `projectToolOutputForModel` in `@orchestral/core`
  rebuilds `assets[]` from the handle whitelist and deletes the legacy
  top-level `assetId`, but passes every other field through untouched — so a
  `videoAssetId`, or a `panels[].assetIds`, reaches the model as a raw id on
  every dispatch. `label` is on that whitelist, which is why the role rides on
  the element rather than in a field name; a consumer (`meta_storyboard`
  reading `meta_image-best-of-n`'s `winner`) finds an asset by label.
  `meta_storyboard`'s `panels[]` carries only the shot's non-asset fields and
  its images are the `panel-<shotIndex>` elements of `assets[]`;
  `meta_explainer-short`'s `scenes[]` carries only `{ type, narration }` and
  its media is in `assets[]` by scene label.

- **Every string in every outputs schema is bounded.** The registry's
  registration-time lint (`OUTPUTS_UNBOUNDED_FIELDS`) audits each pattern's
  outputs for a bare `z.string()`; the shipped catalog — ten atomics,
  `via-caption`, and the seven metas — now registers with zero warnings, and
  a test (`registry-outputs-bounded.test.ts`) keeps it that way. The bounds
  are generous and fit the field (`text-generation.text` 64 KiB, an ASR
  transcript 256 KiB, a judge rationale 2 KiB, …) and are tabled in one place
  — the README's *Conventions* — so they can be retuned together. Array
  lengths the audit cannot bound (`segments[]`, `panels[]`, `assets[]`) are
  documented on the field.

- **Meta authoring surface.** `MetaCommonDeps` (the host-op contract every
  deliverable meta `Pick`s from), plus `firstAsset`, `firstAssetId`,
  `labelAsset`, `labelledAssetShape`, `assetIdByLabel`, `parseJsonWithSchema`,
  `resolvePrompts`, `styleTag`, `sumCosts`, and `toJsonSchemaCached` — the
  helpers a third-party meta needs to build the same cost envelope,
  produced-assets envelope, and prompt fragments the first-party metas do.
  (`toJsonSchemaCached` is memoised and returns a shared object per schema —
  treat the result as immutable; the `-Cached` suffix keeps it distinct from
  `@orchestral/core`'s uncached `toJsonSchema`.)

- **Cost gates on the deliverable metas.** The four deliverable metas —
  `meta_explainer-short`, `meta_product-ad-short`, `meta_product-photo-pack`,
  and `meta_ugc-testimonial` — put their paid multi-generation steps behind a
  `ctx.askUser` checkpoint. The pipeline metas do not; see *Known
  limitations*.

- **Ships an `"orchestral"` manifest in package.json** — the pattern-package
  convention core defines (`OrchestralManifestSchema`). It declares all 18
  patterns as `{ id, kind, export }`, and `requiredOps` is declared *per
  pattern*: only four metas name host operations
  (`meta_explainer-short` → `concatVideos` + `stillToVideo`,
  `meta_ugc-testimonial` → four, `meta_product-ad-short` → two,
  `meta_script2video` → `concatVideos`). The other fourteen declare none, so a
  host with no multimedia backend still loads them:
  `registry.addFromManifest(pkg.orchestral, patterns, undefined, { missingOps: 'skip' })`
  registers those fourteen and reports the four it left out. With the ops in
  hand, `registry.addFromManifest(pkg.orchestral, patterns, ops)` takes the lot.
  `npm view @orchestral/patterns orchestral` prints all of it without
  installing; the `orchestral-pattern` npm keyword is there for the same reason.

- **`CREDITS.md`** records the provenance of prompt text derived from
  HKUDS/ViMax (MIT): the affected constants are listed file by file and the MIT
  license text is reproduced in full. The file ships inside the published
  tarball.

- **`sumCosts` takes an array and returns `number | null`.**
  `sumCosts(costs: readonly (number | null | undefined)[])`, called as `sumCosts([a.cost, ...bs.map((b) => b.cost)])`.
  This follows `@orchestral/core` making envelope `cost` nullable: when any
  input is `null` (an adapter that did not report a cost) the total is `null`,
  because a partial sum renders as a confident small number a host would read
  as the real total. `undefined` still counts as 0 and the NaN / Infinity guard
  is unchanged. Every first-party meta's `cost` is accordingly `number | null`.

### Peer dependencies

- `zod` (`>=4.3 <5`) is a **peer** dependency, not a bundled one. Pattern
  `inputs`/`outputs` are zod schemas on the public API, so your app and
  Orchestral must share a single zod instance — a duplicate copy breaks zod's
  cross-instance checks silently.

### Registration requirements

- `image-to-image` is the only pattern here that ships a default Alternative
  (`via-caption` → `meta_image-to-image-via-caption`). Whether it is ever taken
  is the runtime's call, not this package's: `InlineRuntime`'s
  `alternatives: 'auto' | 'off'` switch **defaults to `'off'`**, so out of the
  box an unservable `image-to-image` fails with the structured
  `ALTERNATIVES_NOT_ENABLED` error that names `meta_image-to-image-via-caption`
  as a path you could dispatch yourself — nothing is redirected, and nothing
  extra has to be registered for that failure to be well-formed.
  **`meta_image-to-image-via-caption` must be registered alongside
  `image-to-image` only if you construct the runtime with
  `alternatives: 'auto'`**; in that mode a missing redirect target fails the job
  with `ALTERNATIVE_PATTERN_NOT_REGISTERED` the first time the fallback fires.
  Pass `alternatives: []` to `createImageToImagePattern` to drop the declaration
  altogether — the failure is then the router's plain `NO_MODEL_FOR_CAPABILITY`,
  with no degraded path offered.

### Known limitations

- **Pipeline metas spend without a confirmation gate, and the amount is set by
  model output.** `meta_script2video` and `meta_storyboard` have no `ctx.askUser`
  checkpoint, and their fan-out is derived from what the planning model returns
  rather than from a caller-supplied bound. `meta_storyboard` renders one image
  per shot, where the shot count is however many shots the design step emits.
  `meta_script2video` renders three portraits per visible character (front, plus
  side and back off the front), then one first frame and one clip per shot, and
  with `transitionMode: 'between-shots'` a further N-1 transition clips — so a
  script the model reads as twelve shots with five characters is 15 + 12 + 12
  (+ 11) paid generations from a single dispatch. If your host bills real money,
  enforce a budget ceiling in the `ModelCapability` you register — these
  patterns will not stop on their own. `meta_image-best-of-n` is the exception
  among the ungated metas: its `n` is capped at 8 by the input schema.

- **`via-caption` image editing is lossy by construction.** When a host has
  opted into automatic alternatives and no image-to-image model is available,
  the job redirects to `meta_image-to-image-via-caption`, which captions the
  source and re-renders it from that caption plus the edit instruction: style
  survives, subject identity and composition do not, and an inpaint `mask` is
  ignored because the whole frame is regenerated. The output sets `degraded` to
  literal `true` and echoes the resolution it asked for as `requestedSize`, so
  an adapter that ignores the requested size shows up as a visible discrepancy
  rather than a silent downgrade. Dispatching the meta directly has the same
  properties — the losses are the path's, not the redirect's.
