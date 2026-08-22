# Changelog

All notable changes to `@orchestral/adapters-ai-sdk` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-21 — Initial public release

### Added

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
