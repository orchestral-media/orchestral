# Changelog

All notable changes to `@orchestral/patterns` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-16 — Initial public release

First public release. `@orchestral/patterns` is the first-party Pattern catalog
for Orchestral: atomic capability patterns, composed meta pipelines, and agent
loops, with their prompts inlined and their inputs/outputs zod-typed. It calls
no provider SDK — every model call goes through the `ModelCapability` your host
registers.

### Added

- **Atomic capability patterns.** Text-to-image, image-to-image, text-to-video,
  image-to-video, text-to-speech, text-to-audio, image-to-text,
  automatic-speech-recognition, text-generation, and more — one pattern per
  capability, each a thin typed envelope over the resolved model call.

- **Meta pipelines and agents.** Composed deliverables (storyboard, script
  planning, idea-to-video, explainer short, product ad short, lyrics-to-MV,
  best-of-N image selection, prose chunking, and others) plus agent patterns
  (long-form video, orchestrator) that drive a tool loop instead of a fixed
  graph.

- **Typed pattern functions.** `textGeneration`, `textToImage`, `imageToText`,
  `textToSpeech`, `textToAudio`, `imageToVideo`, `imageToImage`,
  `automaticSpeechRecognition`, `proseChunkingMeta`, `imageBestOfNMeta`, and
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
  (aggregated across sub-steps; wall-clock compose time), so a generic consumer
  can rely on those fields on any dispatch. Agent patterns keep their distinct
  reserved-cost envelope contract.

- **Meta authoring surface.** `MetaCommonDeps` (the host-op contract every
  deliverable meta `Pick`s from), plus `firstAssetId`, `parseJsonWithSchema`,
  `styleTag`, `sumCosts`, and `toJsonSchemaCached` — the helpers a third-party
  meta needs to build the same cost envelope and prompt fragments the
  first-party metas do. (`toJsonSchemaCached` is memoised and returns a shared
  object per schema — treat the result as immutable; the `-Cached` suffix keeps
  it distinct from `@orchestral/core`'s uncached `toJsonSchema`.)

- **Cost gates on the deliverable metas.** Six metas — `meta_explainer-short`,
  `meta_idea2video`, `meta_lyrics-to-mv`, `meta_product-ad-short`,
  `meta_product-photo-pack`, and `meta_ugc-testimonial` — put their paid
  multi-generation steps behind a `ctx.askUser` checkpoint. The pipeline metas
  and the agent patterns do not; see *Known limitations*.

- **`CREDITS.md`** records the provenance of prompt text derived from
  HKUDS/ViMax (MIT): the affected constants are listed file by file and the MIT
  license text is reproduced in full. The file ships inside the published
  tarball.

### Peer dependencies

- `zod` (`>=4.3 <5`) is a **peer** dependency, not a bundled one. Pattern
  `inputs`/`outputs` are zod schemas on the public API, so your app and
  Orchestral must share a single zod instance — a duplicate copy breaks zod's
  cross-instance checks silently.

### Registration requirements

- `image-to-image` ships a default `via-caption` Alternative, so
  **`meta_image-to-image-via-caption` must be registered alongside it**. A host
  that registers `image-to-image` without the redirect target fails the job with
  `ALTERNATIVE_PATTERN_NOT_REGISTERED` the first time the fallback fires. Pass
  `alternatives: []` to `createImageToImagePattern` if you do not want the
  fallback.

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
  (+ 11) paid generations from a single dispatch. The two agent patterns
  (`agent_long-form-video`, `agent_orchestrator`) likewise never call
  `ctx.askUser`; they rely on the reserved-cost envelope the host enforces. If
  your host bills real money, enforce a budget ceiling in the `ModelCapability`
  you register — these patterns will not stop on their own.
  `meta_image-best-of-n` is the exception among the ungated metas: its `n` is
  capped at 8 by the input schema.

- **`via-caption` image editing is lossy by construction.** When no
  image-to-image model is available, the job redirects to
  `meta_image-to-image-via-caption`, which captions the source and re-renders it
  from that caption plus the edit instruction: style survives, subject identity
  and composition do not, and an inpaint `mask` is ignored because the whole
  frame is regenerated. The output sets `degraded` to literal `true` and echoes
  the resolution it asked for as `requestedSize`, so an adapter that ignores the
  requested size shows up as a visible discrepancy rather than a silent
  downgrade.
