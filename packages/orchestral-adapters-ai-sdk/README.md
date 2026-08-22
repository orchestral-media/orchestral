# @orchestral/adapters-ai-sdk

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

Ready-made `ModelCapability` envelopes over a [Vercel AI SDK](https://ai-sdk.dev)
model instance: `fromImageModel`, `fromSpeechModel`, `fromTranscriptionModel`.
Each one is the ~40-line call adapter a host would otherwise write by hand,
extracted from the examples in this repo, so a host already on the AI SDK
serves `text-to-image`, `text-to-speech` and `automatic-speech-recognition`
without writing one.

```sh
npm install @orchestral/adapters-ai-sdk @orchestral/core ai zod
# plus whichever AI SDK provider you use, e.g.
npm install @ai-sdk/openai
```

`ai` (`^7`) and `zod` (`>=4.3 <5`) are peer dependencies: the model instance you
pass in comes from your copy of the AI SDK, and the package must share it.

## Usage

```ts
import { openai } from '@ai-sdk/openai'
import { createDefaultCapabilityRouter } from '@orchestral/core'
import { fromImageModel, fromSpeechModel } from '@orchestral/adapters-ai-sdk'

const models = [
  fromImageModel(openai.image('gpt-image-1'), { tags: ['fast'] }),
  fromSpeechModel(openai.speech('tts-1')),
]
const router = createDefaultCapabilityRouter({
  getModels: (cap) => models.filter((m) => m.capabilities.includes(cap)),
})
```

That replaces the hand-written `ModelCapability` in the root README's
"Minimal example"; everything after the router (registry, runtime, `submitJob`)
is unchanged. The hand-written version is still the right thing to read once —
it is the seam every adapter, this package included, sits on.

## Architecture constraint: this is a leaf

**Nothing in orchestral depends on this package, and nothing ever will.**

`@orchestral/core` never imports a provider SDK; a host serves a capability by
writing a `ModelCapability.call` adapter over whatever SDK it already uses. That
stays true. This package is one such adapter, shipped: it depends on
`@orchestral/core` and on `ai`, and the arrow never reverses. A host on a
different SDK — a vendor's own client, a local inference server — writes its
own adapter exactly as before and never installs this one.

It sits on the main `@orchestral/*` version line (unlike `@orchestral/dsh-plugin`)
because it targets the AI SDK's *stable* model specification, not a developer
preview. When a future AI SDK major changes that specification, this package's
peer range moves and the other packages do not notice.

Treat any pressure to "just have core accept an AI SDK model directly" as the
bug it is.

## What each function maps

| Function | AI SDK call | Capability | Reads off the input | Asset slot consumed | Output schema (`@orchestral/patterns`) |
| --- | --- | --- | --- | --- | --- |
| `fromImageModel(model, options?)` | `generateImage` | `text-to-image` | `prompt`; `size` (`WxH`), `aspectRatio` (`W:H`), `n`, `seed`; flat `providerOptions` | none — `reference` / `control` are **not** mapped | `TextToImageOutputSchema` |
| `fromSpeechModel(model, options?)` | `generateSpeech` | `text-to-speech` | `text`; `voice`, `outputFormat`, `instructions`, `speed`, `language`; flat `providerOptions` | none — `voiceClone` is **not** mapped | `TextToSpeechOutputSchema` |
| `fromTranscriptionModel(model, options)` | `transcribe` | `automatic-speech-recognition` | flat `providerOptions` | `source` (required) via `options.loadAudio` | `AutomaticSpeechRecognitionOutputSchema` |

Every envelope declares `specificationVersion: MODEL_SPEC_VERSION`,
`source: 'user'`, the capability's `inputs` / `outputs` modalities, and
`provider` / `modelId` read off the model instance (override either with
`options.provider` / `options.modelId` when the host's catalog row is not the
SDK's id). `options.tags` and `options.tier` go straight onto the envelope.

Every `call` passes `ctx.signal` to the SDK as `abortSignal`, measures
`latencyMs` around the SDK call, and returns the output of the matching
first-party pattern field-for-field — the package's tests assert
`Schema.parse(output)` succeeds for each. Produced media also travels on
`DispatchResult.artifacts` and fires `events.onArtifact` once per file.

The `model` parameter is the resolved model **object** (`openai.image('…')`),
not the `'provider:model-id'` string some AI SDK helpers accept through a
provider registry: the adapter has to read `.provider` / `.modelId` off it. The
exported `ImageModelInstance` / `SpeechModelInstance` /
`TranscriptionModelInstance` types are that object form.

### `providerOptions`

Two sources feed the SDK's `providerOptions`, and they are shaped differently:

- `ctx.providerOptions` (the `JobSpec.providerOptions` a host submits) is passed
  through **verbatim** — it is expected to already be in the AI SDK's wire shape,
  keyed by provider name: `{ openai: { quality: 'high' } }`.
- `input.providerOptions` — the **flat** per-model object the first-party
  patterns carry on the top level of their input (a meta `compose()` sets it; the
  derived LLM-facing schema fills it per model) — is nested under the model's
  provider key.

Per-call wins: a key in `input.providerOptions` overrides the same key in
`ctx.providerOptions[provider]`.

### Transcription needs a loader

```ts
import { fromTranscriptionModel } from '@orchestral/adapters-ai-sdk'

fromTranscriptionModel(openai.transcription('whisper-1'), {
  // The runtime resolves `input.references.source` to a real assetId and puts
  // it on ctx.assets; only the host knows how to turn that id into bytes.
  loadAudio: async (ref) => store.readBytes(ref.assetId), // Uint8Array | ArrayBuffer | URL
})
```

`loadAudio` is required, not optional: an orchestral `assetId` is an opaque
host identifier, and `@orchestral/core` deliberately defines no way to read its
bytes. Return a `URL` (`https:`, `file:`, or a `data:` URI) to let the SDK do
the download. The media type is sniffed from the bytes by the SDK either way.

## Honest limitations

- **`cost` is always `null`.** The AI SDK does not report what a call cost, and
  the output envelope's `null` means exactly "not reported" — a `0` would claim
  the call was free. A host with a price list fills it in afterwards (a
  `DispatchMiddleware`, or its own wrapper around `call`).
- **Asset slots other than ASR `source` are not mapped.** `text-to-image`'s
  `reference` / `control` images and `text-to-speech`'s `voiceClone` audio are
  resolved onto `ctx.assets` by the runtime but ignored here: `generateImage`'s
  image-editing input and the various voice-cloning APIs are provider-specific
  enough that a generic mapping would be a guess. A host that needs them writes
  its own adapter (or wraps this one and adds them).
- **ASR `language` / `prompt` / `timestamps` / `format` are not mapped.**
  `transcribe` in AI SDK 7 has no shared fields for any of them — each provider
  names them differently under `providerOptions` (`openai: { language,
  prompt, timestampGranularities }`, …). Pass them as `providerOptions` for the
  provider you resolved. Word-level `words` is never emitted; `segments` is
  whatever the provider returned, already in seconds.
- **`audioDurationMs` is only set for ASR.** `generateSpeech` does not report
  the length of the audio it produced.
- **No progress events.** `generateImage` / `generateSpeech` / `transcribe` are
  single awaited calls with nothing in between, so `events.onProgress` is never
  fired. `onArtifact` fires once per produced file.
- **`assets[].url` is not set; the bytes are artifacts.** Every produced file
  is returned in `DispatchResult.artifacts` and fired on `events.onArtifact`
  (the runtime's `job:artifact` event) as a `data:` URI. Nothing is inlined
  in the output: `producedAssetShape.url` is bounded to 2048 chars precisely
  so a multi-megabyte blob cannot ride in a value a model or a transcript
  might see, and a real image or audio file is far larger than that. A host
  collects the artifacts — subscribe from `InlineRuntimeInit.onJobCreated`,
  which fires for every job including the children of a meta or agent —
  stores the bytes, and rewrites `assets[].url` / `assetId` to its own
  canonical handles if it wants them on the output. `assetId` is a placeholder
  (`aisdk-image-0`) until it does.
- **One spec version per envelope.** Each envelope declares the adapter-contract
  generation it was built against (`MODEL_SPEC_VERSION`); a runtime that cannot
  execute it refuses the envelope with `MODEL_SPEC_VERSION_UNSUPPORTED` rather
  than calling into it.

## Versioning

Shares the `@orchestral/*` version line (`0.x`: minor versions may break,
patch versions never do) and is published together with the other packages.
The `ai` peer range tracks the AI SDK major whose model specification the
adapters are written against.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
