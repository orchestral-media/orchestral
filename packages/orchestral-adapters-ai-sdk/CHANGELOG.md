All notable changes to `@orchestral/adapters-ai-sdk` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

# Changelog

## [0.1.0] - 2026-08-25 — Initial public release

### Added

- **`AdapterOptions.mintAssetId`** — `(artifact, index, ctx) => string`,
  called by `fromImageModel` and `fromSpeechModel` once per produced file, in
  output order; the string returned is that `assets[]` element's `assetId`.
  The producing-side counterpart of `loadAudio` / `loadImage`: a host that
  stores the bytes mints the id it stores them under, and the output carries
  it at the moment it is produced rather than after the runtime has handed it
  on. The id is checked against `assetIdField()`'s bound (non-empty, at most
  128 characters); an invalid one fails the call with `MINT_ASSET_ID_INVALID`
  (attached as `Error.code`) before any artifact event fires. Optional — the
  default is the placeholder the adapters always emitted (`aisdk-image-<i>`,
  `aisdk-audio-0`).
- **`fromLanguageModel(model, options?)`** — `generateText` as
  `text-generation`, the capability every first-party meta dispatches and the
  one the package did not serve. Reads `prompt`, `system`, the sampling fields
  the pattern already names after the SDK's (`maxOutputTokens`, `temperature`,
  `topP`, `topK`, `stopSequences`), `responseFormat` / `jsonSchema`, and a
  flat `providerOptions`; returns a `TextGenerationOutput` with `usage` when
  reported and `finishReason` on the pattern's enum.
- **`fromVisionModel(model, options)`** — `generateText` on a vision-capable
  language model as `image-to-text`. Every resolved `source` asset is loaded
  through the required `options.loadImage` (same posture as `loadAudio`) and
  sent as a `file` part, in `ctx.assets` order, ahead of the prompt text;
  `mode` / `system` / `prompt` / `maxLength` follow the pattern's field
  descriptions. `VisionAdapterOptions`, `ImageSource`, and the
  `LanguageModelInstance` object type the two share.
- **Structured output.** Both map `responseFormat: 'json'` onto the SDK's v7
  `output` (`Output.object` over the caller's `jsonSchema`, `Output.json`
  without one), validate the reply against that schema through zod's
  `fromJSONSchema`, and return the object in `text` as JSON — the shape the
  first-party metas parse.
- **Produced artifacts carry `meta.assetId`.** Every artifact `fromImageModel`
  and `fromSpeechModel` return on `DispatchResult.artifacts` and fire on
  `events.onArtifact` (the runtime's `job:artifact` event) is stamped with the
  `assetId` of its output element — minted or placeholder — so a host that
  collects bytes from the event and one that reads the output look up the
  same key. The speech artifact's `meta.format` rides alongside it.

- **AI SDK model instance → `ModelCapability` envelope.** The call adapter a
  host on the Vercel AI SDK would otherwise write by hand, extracted from the
  repo's examples and shipped as a leaf package: it depends on
  `@orchestral/core` and `ai` (`^7`, peer), and nothing in `@orchestral/*`
  depends on it.

  - `fromImageModel(model, options?)` — `generateImage` as `text-to-image`.
    Reads `prompt` plus the pattern's `ImageGenerationParams` (`size`,
    `aspectRatio`, `n`, `seed`) and a flat `providerOptions`; returns a
    `TextToImageOutput` with one `assets[]` element per image.
  - `fromSpeechModel(model, options?)` — `generateSpeech` as `text-to-speech`.
    Reads `text` and the SDK's shared speech fields (`voice`, `outputFormat`,
    `instructions`, `speed`, `language`); returns a `TextToSpeechOutput`.
  - `fromTranscriptionModel(model, options)` — `transcribe` as
    `automatic-speech-recognition`. Reads the resolved `source` asset off
    `ctx.assets` and loads it through the required `options.loadAudio`;
    returns an `AutomaticSpeechRecognitionOutput` (`segments` in seconds,
    `language` / `audioDurationMs` when reported).
  - `AdapterOptions` (`provider` / `modelId` overrides, `tags`, `tier`),
    `TranscriptionAdapterOptions`, `AudioSource`, and the
    `ImageModelInstance` / `SpeechModelInstance` / `TranscriptionModelInstance`
    object types.

  Every envelope declares `specificationVersion: MODEL_SPEC_VERSION` and
  `source: 'user'`; every call passes `ctx.signal` as `abortSignal`, measures
  `latencyMs`, and reports `cost: null` — the AI SDK does not report cost, and
  `null` is the envelope's word for "not reported".
