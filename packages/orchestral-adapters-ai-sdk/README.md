# @orchestral/adapters-ai-sdk

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

Ready-made `ModelCapability` envelopes over a [Vercel AI SDK](https://ai-sdk.dev)
model instance: `fromLanguageModel`, `fromVisionModel`, `fromImageModel`,
`fromSpeechModel`, `fromTranscriptionModel`. Each one is the ~40-line call
adapter a host would otherwise write by hand, extracted from the examples in
this repo, so a host already on the AI SDK serves `text-generation` (the
capability every first-party meta dispatches), `image-to-text`,
`text-to-image`, `text-to-speech` and `automatic-speech-recognition` without
writing one.

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
import {
  fromImageModel,
  fromLanguageModel,
  fromSpeechModel,
  fromVisionModel,
} from '@orchestral/adapters-ai-sdk'

const models = [
  fromLanguageModel(openai('gpt-4o-mini'), { tags: ['fast'] }),
  fromVisionModel(openai('gpt-4o'), {
    // Only the host knows how an assetId becomes bytes — see below.
    loadImage: async (ref) => store.readBytes(ref.assetId),
  }),
  fromImageModel(openai.image('gpt-image-1'), {
    tags: ['fast'],
    // …and only the host knows what id the bytes are stored under. Mint it
    // here and the output carries it — see below.
    mintAssetId: (artifact) => store.record(artifact),
  }),
  fromSpeechModel(openai.speech('tts-1'), {
    mintAssetId: (artifact) => store.record(artifact),
  }),
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
| `fromLanguageModel(model, options?)` | `generateText` | `text-generation` | `prompt`; `system`; `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences`; `responseFormat` + `jsonSchema`; flat `providerOptions` | none — the pattern declares no asset slot | `TextGenerationOutputSchema` |
| `fromVisionModel(model, options)` | `generateText` on a vision model | `image-to-text` | `mode`, `system`, `prompt`, `maxLength`; `responseFormat` + `jsonSchema`; flat `providerOptions` | `source` (required, one or more) via `options.loadImage` | `ImageToTextOutputSchema` |
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
`DispatchResult.artifacts` and fires `events.onArtifact` once per file, each
artifact stamped with its output element's `assetId` on `meta.assetId`; the
id itself is the host's to mint (`options.mintAssetId`, below).

The `model` parameter is the resolved model **object** (`openai('…')`,
`openai.image('…')`), not the `'provider/model-id'` string some AI SDK helpers
accept through a provider registry: the adapter has to read `.provider` /
`.modelId` off it. The exported `LanguageModelInstance` (shared by
`fromLanguageModel` and `fromVisionModel`) / `ImageModelInstance` /
`SpeechModelInstance` / `TranscriptionModelInstance` types are that object
form.

### `providerOptions`

Two sources feed the SDK's `providerOptions`, and they are shaped differently:

- `ctx.providerOptions` (the `JobSpec.providerOptions` a host submits) is passed
  through **verbatim** — it is expected to already be in the AI SDK's wire shape,
  keyed by provider name: `{ openai: { quality: 'high' } }`.
- `input.providerOptions` — the **flat** per-model object the first-party
  patterns carry on the top level of their input (a meta `compose()` sets it; the
  derived LLM-facing schema fills it per model) — is nested under the model's
  **SDK provider key**: the first `.`-separated segment of the model instance's
  own `.provider` (`openai.image` → `openai`), which is the name the SDK's
  provider matches against. That is deliberately *not* `options.provider`: the
  routing identity is yours to overwrite with a relay slug, and options nested
  under a slug no provider answers to are dropped without a word. Override the
  wire key with `options.sdkProviderKey` when the segment rule is wrong for the
  provider you registered.

Per-call wins: a key in `input.providerOptions` overrides the same key in
`ctx.providerOptions[sdkProviderKey]`.

### Structured output (`responseFormat: 'json'`)

`text-generation` and `image-to-text` carry the same pair: `responseFormat`
(`'text'` | `'json'`) and an opaque `jsonSchema`. Both adapters map `'json'`
onto the AI SDK's v7 structured output — `generateText`'s `output` option
(`Output.object({ schema })` with a schema, `Output.json()` without one);
there is no separate `generateObject` call in v7 to reach for. The SDK sends
the schema to the provider as its JSON response format and parses the reply.

The reply is then **validated against the caller's JSON Schema** before the
adapter returns: `jsonSchema` is compiled with zod's `z.fromJSONSchema` and
handed to the SDK as the schema's `validate` hook, so a reply that parses but
does not match fails the call (`No object generated: response did not match
schema.`) instead of reaching a meta that will `JSON.parse` it and choke on a
field later. A reply cut off before a `stop` finish fails the same way.

The object lands in the output's `text` as a JSON string — the shape every
first-party meta reads (`JSON.parse(judgeOut.text)`,
`parseJsonWithSchema(out.text, schema)`). Neither pattern's output schema
declares a separate object field, and the adapters invent none. The
`toJsonSchemaCached(zodSchema)` a meta passes is what the round trip is
tested against.

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

### Vision needs one too

```ts
import { fromVisionModel } from '@orchestral/adapters-ai-sdk'

fromVisionModel(openai('gpt-4o'), {
  // Called once per `source` asset, in ctx.assets order. Return bytes or a
  // URL (the SDK sniffs the media type), or state it: { data, mediaType }.
  loadImage: async (ref) => {
    const { mime, base64 } = await store.read(ref.assetId)
    return { data: base64, mediaType: mime }
  },
})
```

Same posture as `loadAudio`, for the same reason. `image-to-text` declares
its `source` slot with array cardinality, and the adapter honours that: every
resolved `source` ref becomes a `file` part of the one user message, in
`ctx.assets` order, ahead of the prompt text — so a meta that sends reference
images and candidates in a deliberate order (`image-best-of-n`'s judge) gets
them in that order. `mode` / `system` / `prompt` land where the pattern's own
field descriptions say: `system` wins and `mode` is ignored; without a
`system`, a `prompt` replaces the mode-default text; with neither, the mode
default is the system text and the images go up alone.

### Produced media needs an id

```ts
import { fromImageModel, fromSpeechModel } from '@orchestral/adapters-ai-sdk'

fromImageModel(openai.image('gpt-image-1'), {
  // Called once per produced file, in output order, with the artifact (the
  // bytes as a data: URI, plus mime), its index, and the dispatch context.
  // Whatever it returns is that element's `assetId`.
  mintAssetId: (artifact, index, ctx) => store.record(artifact, ctx.rootJobId),
})
fromSpeechModel(openai.speech('tts-1'), {
  mintAssetId: (artifact) => store.record(artifact),
})
```

The same posture as `loadAudio` / `loadImage`, on the producing side. An
orchestral `assetId` is whatever the host's store says it is, and the id on a
`text-to-image` output is what the next step of a meta resolves and hands to
`loadImage` — so it has to be the id the host stored the bytes under, at the
moment the output is produced. Rewriting `assets[].assetId` afterwards is too
late: the runtime has already handed the output on. `mintAssetId` is where a
host that stores the bytes mints the id it stores them under; the adapter
never sees the store.

The minted id is also stamped on the artifact's `meta.assetId` before
`events.onArtifact` fires, so a host that collects bytes from the
`job:artifact` event and one that reads `assets[]` off the output look up the
same key (`artifacts[i]` is `assets[i]` by position as well). The returned id
must be a non-empty string of at most 128 characters (`assetIdField()`'s
bound); anything else fails the call with `MINT_ASSET_ID_INVALID` before any
artifact event fires, rather than emitting an output the schema would reject.

Optional, unlike the two loaders: without it the id is a positional
placeholder (`aisdk-image-0`, `aisdk-audio-0`) that names nothing in any
store — enough for a host that only ever reads the artifacts, and what
`examples/consented-fallback` replaces with its store's own ids.

## Honest limitations

- **`cost` is always `null`.** The AI SDK does not report what a call cost, and
  the output envelope's `null` means exactly "not reported" — a `0` would claim
  the call was free. A host with a price list fills it in afterwards (a
  `DispatchMiddleware`, or its own wrapper around `call`).
- **Asset slots other than the two `source` slots are not mapped.**
  `text-to-image`'s `reference` / `control` images and `text-to-speech`'s
  `voiceClone` audio are resolved onto `ctx.assets` by the runtime but ignored
  here: `generateImage`'s image-editing input and the various voice-cloning
  APIs are provider-specific enough that a generic mapping would be a guess. A
  host that needs them writes its own adapter (or wraps this one and adds
  them). ASR's and image-to-text's `source` are mapped, through `loadAudio` /
  `loadImage`.
- **`loadImage` / `loadAudio` are the host's, not defaults.** `@orchestral/core`
  defines no assetId → bytes read on purpose (an id is whatever the host's
  store says it is), so the adapters cannot ship one; a vision or transcription
  adapter without the hook would have nothing to send.
- **`image-to-text`'s `maxLength` is an instruction, not a cut.** The pattern
  declares it a *soft* cap in characters, and the only way to give a model a
  soft cap is to ask: in text mode the adapter appends `Keep the answer under
  N characters.` to the user text. The reply is never truncated (a cut JSON
  document is worse than a long one), and the hint is left out of a
  `responseFormat: 'json'` request, whose shape is the schema's business.
- **`jsonSchema` has to be something zod can compile.** Validation runs
  through `z.fromJSONSchema` (draft 2020-12 / draft-7 / draft-4 / OpenAPI 3.0;
  no `if` / `then` / `else`, no unresolved `$ref`), and a schema it rejects
  fails the call *before* the model is called rather than running a
  validated-looking call that validated nothing. Anything rendered by
  `toJsonSchemaCached` / `z.toJSONSchema` compiles. In `'json'` mode `text` is
  the validated object re-serialised, not the model's raw characters.
- **`text-generation`'s `usage` and `finishReason` are best effort.** `usage`
  is set only when the provider reported both token counts; `finishReason`
  maps the SDK's unified reasons onto the pattern's enum, and the SDK's
  `error` — which the pattern does not name — lands on `other`.
- **ASR `language` / `prompt` / `timestamps` / `format` are not mapped.**
  `transcribe` in AI SDK 7 has no shared fields for any of them — each provider
  names them differently under `providerOptions` (`openai: { language,
  prompt, timestampGranularities }`, …). Pass them as `providerOptions` for the
  provider you resolved. Word-level `words` is never emitted; `segments` is
  whatever the provider returned, already in seconds.
- **`audioDurationMs` is only set for ASR.** `generateSpeech` does not report
  the length of the audio it produced.
- **No progress events.** `generateText` / `generateImage` / `generateSpeech`
  / `transcribe` are single awaited calls with nothing in between, so
  `events.onProgress` is never fired. `onArtifact` fires once per produced
  media file; the two text adapters produce none.
- **`assets[].url` is not set; the bytes are artifacts.** Every produced file
  is returned in `DispatchResult.artifacts` and fired on `events.onArtifact`
  (the runtime's `job:artifact` event) as a `data:` URI. Nothing is inlined
  in the output: `producedAssetShape.url` is bounded to 2048 chars precisely
  so a multi-megabyte blob cannot ride in a value a model or a transcript
  might see, and a real image or audio file is far larger than that. A host
  collects the artifacts — subscribe from `InlineRuntimeInit.onJobCreated`,
  which fires for every job including the children of a meta or agent — and
  stores the bytes. The `assetId` on the output is the host's to mint through
  `mintAssetId` (above), at the moment the output is produced; without the
  hook it is a placeholder (`aisdk-image-0`) that names nothing. `url` is
  never set either way — a host with public URLs serves them from its store
  by that id.
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
