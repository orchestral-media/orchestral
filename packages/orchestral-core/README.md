# @orchestral/core

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

A media-agent kit with capability-level semantic fallback — a substrate-agnostic
orchestration layer that stays provider-SDK-free: you inject the model call.
(The examples bridge to the Vercel [`ai`](https://ai-sdk.dev) SDK, but any
provider SDK fits behind the same one-function adapter.)

`@orchestral/core` is the vocabulary and contracts at the centre of Orchestral:
the `Pattern` / `ModelCapability` / `Alternative` model, the `Job` / `JobStore` /
`Runtime` interfaces, the default capability router, and the pattern registry. It
ships **no execution engine** and touches **no provider SDK** — you bring a
runtime (`@orchestral/runtime`), a pattern catalog (`@orchestral/patterns`), and
your own model bridge (a ~15-line `call` adapter over the provider SDK you use).

## Install

```sh
npm install @orchestral/core @orchestral/runtime @orchestral/patterns zod
```

`zod` (v4) is a peer dependency — Pattern input/output schemas on the public
API are zod schemas, so your app and Orchestral must share a single zod
instance (duplicate copies break zod's cross-instance checks).

Calling a model is host territory — Orchestral ships **no** provider adapter. To
serve a capability you write a tiny `ModelCapability.call` adapter over your
provider SDK (e.g. the Vercel `ai` SDK's `generateImage`). The runnable
[`examples/atomic-hello-world`](https://github.com/orchestral-media/orchestral/tree/main/examples/atomic-hello-world)
shows that adapter end to end in ~50 lines (`src/ai-sdk-wiring.ts`).

## Minimal example

Wire the four seams together and submit a text-to-image job. The host owns the
model instance and its key; everything else is plumbing the packages provide.

```ts
import {
  PatternRegistry,
  InMemoryJobStore,
  createDefaultCapabilityRouter,
  type DispatchContext,
  type DispatchResult,
  type ModelCapability,
} from '@orchestral/core'
import { InlineRuntime } from '@orchestral/runtime'
import { createTextToImagePattern } from '@orchestral/patterns'
import { generateImage } from 'ai'
import { openai } from '@ai-sdk/openai'

// 1. Register the atomic patterns you want to expose.
const registry = new PatternRegistry()
registry.add(createTextToImagePattern())

// 2. Bridge your provider SDK to a ModelCapability envelope. The `call` adapter
//    is the host's — core never imports a provider SDK. It is generic in its
//    output type (the runtime's caller picks `O`), so the adapter builds the
//    concrete envelope the pattern's `outputs` schema expects and casts once on
//    the way out. (~15 lines; the `examples/atomic-hello-world`
//    ai-sdk-wiring.ts is a copy-paste reference.)
const imageModel = openai.image('gpt-image-1')
const model: ModelCapability = {
  capabilities: ['text-to-image'],
  provider: 'openai',
  modelId: 'gpt-image-1',
  inputs: ['text'],
  outputs: ['image'],
  tags: [],
  source: 'user',
  async call<I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> {
    const { prompt } = input as { prompt: string }
    const startedAt = Date.now()
    const { images } = await generateImage({
      model: imageModel,
      prompt,
      abortSignal: ctx.signal,
    })
    const assets = images.map((img, i) => ({
      assetId: `img-${i}`,
      modality: 'image' as const,
      url: `data:${img.mediaType ?? 'image/png'};base64,${img.base64}`,
    }))
    const output = {
      modality: 'image' as const,
      assets,
      cost: 0,
      latencyMs: Date.now() - startedAt,
      model: 'openai:gpt-image-1',
      provider: 'openai',
    }
    return { output: output as O }
  },
}

// 3. The default router selects a model per (capability, tags, ctx). It reads
//    the envelopes from `getModels` and never touches a provider SDK itself.
const router = createDefaultCapabilityRouter({
  getModels: (cap) => (cap === 'text-to-image' ? [model] : []),
})

// 4. The in-process runtime dispatches jobs through the router.
const runtime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router,
})

// 5. Submit. `submitJob` resolves when the job reaches a terminal state.
const job = await runtime.submitJob({
  patternId: 'text-to-image',
  input: { prompt: 'a watercolour fox in a misty forest' },
})

console.log(job.status) // 'done'
console.log(job.output) // { modality: 'image', assets: [...] }
```

## The three seams

A host adopts Orchestral by satisfying three injection points. Two are stores you
swap; the third is the call adapter:

- **`JobStore`** — where job rows live. `InMemoryJobStore` ships for dev/test; a
  host supplies a durable store (e.g. a SQLite-backed one) for production.
- **`CapabilityRouter`** — which model answers a capability. Use
  `createDefaultCapabilityRouter` and inject `getModels` (the candidate
  envelopes) plus an optional `getCapabilityOrder` (the enablement gate).
- **`ModelCapability.call`** — the actual provider invocation. This is
  **host-injected** — core never imports a provider SDK. You write a ~15-line
  adapter over your provider SDK (the runnable `examples/atomic-hello-world`'s
  `ai-sdk-wiring.ts` is a copy-paste reference for the Vercel `ai` SDK).

## Meta patterns (a fixed plan)

A `MetaPattern` replaces the model call with a `compose()` that dispatches
sub-patterns through `ctx.step` (`createPatternFn` is the typed wrapper). The
plan is host code, so it is deterministic and reviewable:

```ts
const textToImage = createPatternFn<TextToImageInput, TextToImageOutput>('text-to-image')

const contactSheet: MetaPattern<Input, Output> = {
  id: 'meta_contact-sheet',
  kind: 'meta',
  description: 'Render one image per prompt and return the whole sheet.',
  tool: { description: '…', inputs: InputSchema },
  outputs: OutputSchema,
  async compose({ input }, ctx) {
    const outs = await parallel(
      // stepId keeps the fan-out from collapsing into one cached step.
      input.prompts.map((prompt, i) => textToImage(ctx, { prompt }, { stepId: `render-${i}` })),
    )
    return { assetIds: outs.map((o) => o.assets[0].assetId), cost: 0, latencyMs: 0 }
  },
}
```

For a production-scale exemplar — fan-out, a VLM judge step, asset threading
between steps — read `meta_image-best-of-n` in
[`@orchestral/patterns`](https://www.npmjs.com/package/@orchestral/patterns),
whose README carries a [generated catalog](https://github.com/orchestral-media/orchestral/blob/main/packages/orchestral-patterns/README.md#catalog)
of every shipped pattern: input slots, outputs, and the host operations each one
expects you to supply.

## Agent patterns (a plan decided at runtime)

An `AgentPattern` hands scheduling to an inner LLM loop. The pattern declares
the loop; it contains no imperative plan:

```ts
const director: AgentPattern<DirectorInput> = {
  id: 'agent_art-director',
  kind: 'agent',
  description: 'Iterate on an image brief until it looks right.',
  primary: { tool: { description: '…', inputs: agentInputSchema({ styleNotes: z.string().optional() }) } },
  loop: {
    system: 'You are an art director. Render, critique, and re-render.',
    toolPatternIds: ['text-to-image', 'image-to-text'],
    modelTags: [],
  },
}
```

Driving that loop is host territory, like `ModelCapability.call`: the runtime
needs an `AgentRunImpl` bridging to whatever agent SDK you use. The runnable
[`examples/agent-hello-world`](https://github.com/orchestral-media/orchestral/tree/main/examples/agent-hello-world)
shows one over the Vercel `ai` SDK's tool loop (`src/agent-runner.ts`). The
agent seam is `@alpha` — expect it to move before 1.0.

## Asset handles in brief

Media inputs never travel as raw ids through the LLM. The chain is four steps:

1. The host **records** what exists in a context as `AssetEvent[]` (`assetId` +
   `modality`, plus an optional label and a monotonic `orderHint`).
2. `buildAssetIndex(events)` mints stable per-context, per-modality **handles**
   (`image_1`, `video_2`) and returns a lookup index.
3. The LLM only ever sees and fills handles, in `input.references.{slot}`. The
   slots come from the pattern's `assetNeeds` declaration.
4. `resolveAssetReferences(input, assetNeeds, index)` turns those handles back
   into real ids and lands them on **`ctx.assets`** as
   `{ slot, assetId, modality }` — what your `call` adapter reads. It is
   fail-closed: an unknown slot or an unresolvable handle is an error, never a
   silent drop.

Handles are per-context and per-`assetId`; they are not global names, so never
persist one as an identifier.

## Semantic fallback (`Alternative`)

The capability-level fallback in the tagline is declarative data on a pattern.
When the router reports the parent capability unsatisfiable, the runtime
redirects the dispatch through another pattern instead of failing:

```ts
// Shipped on `image-to-image` in @orchestral/patterns: with no image-to-image
// model in the catalog, caption the source and re-render from that text.
const viaCaption: Alternative<ImageToImageInput, ImageToImageOutput> = {
  id: 'via-caption',
  description: 'No image-to-image model is available: caption the source image, then re-render it.',
  appliesWhen: whenCapabilityUnavailable(), // pass ModelTags to require them
  costMultiplier: 2,  // two model calls (caption + render) replace one edit call
  qualityDelta: -0.5,
  via: {
    patternId: 'meta_image-to-image-via-caption',
    // The source image rides in the dispatch ctx, so only the intent is remapped.
    mapInput: (input) => ({ editPrompt: input.prompt, tier: 'preview' }),
    // Project field by field rather than casting the child envelope across.
    // `degraded` / `requestedSize` are deliberately not projected: the
    // degradation is already reported out-of-band by `job:alternative-selected`
    // (which carries `losses` / `qualityDelta`), and the requested size belongs
    // to the child's own render, not the parent's contract.
    mapOutput: (childOutput) => {
      const out = childOutput as ImageToImageViaCaptionOutput
      return {
        modality: 'image',
        assets: out.assets,
        cost: out.cost,
        latencyMs: out.latencyMs,
        model: out.model,
        provider: out.provider,
      }
    },
  },
  preserves: ['style'],
  losses: ['subject-identity', 'composition'], // reported as a degradation notice
}
```

The redirect target must be registered too: with `meta_image-to-image-via-caption`
absent from the registry, the runtime throws
`ALTERNATIVE_PATTERN_NOT_REGISTERED` instead of falling back.

`whenCapabilityUnavailable('identity-preserving')` narrows the trigger to "no
model bearing this tag"; `whenPreservesRequired(...)` triggers on the caller's
declared semantic requirements. The runtime picks the **first** alternative
whose `appliesWhen` matches — declaration order is the ranking — and emits
`job:alternative-selected` carrying the `losses` so the host can tell the user
what it gave up.

`via-caption` is the **only** alternative `@orchestral/patterns` ships by
default, and that is a position rather than a coverage gap: a fallback is honest
only when some other capability can reconstruct the caller's intent, and
`image-to-text` + `text-to-image` is the one pair in the first-party catalog that
carries content across a modality gap. There is no video-to-text or
describe-this-audio capability to build the equivalent bridge for a clip or a
recording, and reading a music prompt aloud is a different job, not a degraded
one. Each pattern without a fallback says why next to its `alternatives` field;
with no model for those, a job fails with the router's
`NO_MODEL_FOR_CAPABILITY` instead of quietly producing something adjacent.
Attaching your own is a first-class move: every atomic factory takes an
`alternatives` option, which replaces the shipped list outright.

## Swapping the batteries

The example above runs entirely on in-memory dev batteries. Moving to production
means replacing two implementations — **the `InlineRuntime` construction does not
change**, only what you hand it:

- **`InMemoryJobStore` → a durable `JobStore`** (e.g. your host's
  `SqliteJobStore`). Same `JobStore` interface; jobs now survive a restart.
- **`createDefaultCapabilityRouter`'s `getModels` → a DB-backed lookup.** The dev
  example reads a static in-memory registry; a host points `getModels` at its own
  model table and wires `getCapabilityOrder` to its enablement state. The router
  algorithm — `(capability, tags, ctx) → model` — is unchanged.

```ts
const runtime = new InlineRuntime({
  store: new SqliteJobStore(db),                       // was InMemoryJobStore
  registry,
  router: createDefaultCapabilityRouter({
    getModels: (cap) => db.modelsForCapability(cap),   // was static registry
    getCapabilityOrder: (cap) => db.enabledOrder(cap),
  }),
})
```

## Human-in-the-loop (`ctx.askUser`)

A meta pattern's `compose()` can pause mid-run to ask the user something:

```ts
const ok = await ctx.askUser.confirm({ title: 'Use draft 2?' }) // boolean
```

Mechanics a host must know:

- The runtime forwards each ask to the host's `AskUserHandler` (injected via
  `InlineRuntimeInit.askUser`) and awaits the returned promise. The host
  renders the payload however it likes and resolves with the user's answer;
  the runtime validates it against `answerSchema` when one is provided.
- The park is **in-memory**: the job stays `running` (there is no `paused`
  `JobStatus`) and compose's local state lives on the JS stack. It survives
  only as long as the process — after a crash, `reconcile()` marks the job
  `stale`.
- `askUser.confirm` / `choose` / `form` cover the common widgets with typed
  question/answer contracts; `askUser.custom` passes an arbitrary payload for
  a bespoke widget.

## API map

The barrel is wide; hello-world composes with a handful of symbols:

| You want to… | Reach for |
| --- | --- |
| Register patterns | `PatternRegistry` |
| Bridge your provider SDK | `ModelCapability` (write its `call` adapter) |
| Route capability → model | `createDefaultCapabilityRouter` / implement `CapabilityRouter` |
| Run and store jobs | `Runtime` + `InMemoryJobStore` (+ `InlineRuntime` from `@orchestral/runtime`) |
| Author patterns | `defineAtomicPattern` (atomic entry point) / `MetaPattern` / `AgentPattern`, `Alternative` + `when*` builders |
| Pause for a human | `ctx.askUser` + `AskUserHandler` (see above) |
| Type a sub-pattern call | `createPatternFn` |

Everything else on the barrel (asset-ledger primitives, catalog/discovery
helpers such as `handleFindPattern` / `PatternSearchIndex` /
`resolveDispatchTarget`, schema derivation utilities) exists for hosts that
expose the catalog to an LLM as tools. Adopt those incrementally — none are
needed for hello-world.

## Declared but not implemented in 0.x

Some fields on the public types are declarative metadata that nothing in this
package consumes yet. They are honest to *write* — a host router or a planner UI
can read them — but writing one changes no built-in behaviour:

| Field | Status in 0.x |
| --- | --- |
| `ModelCapability.cost` / `.latencyMs` | Never read. The default router does not rank by cost or latency. |
| `ModelCapability.tier` | Read **only** when the caller passes `ResolveContext.tier`, and then best-effort: the first tier match wins, otherwise it falls through. |
| `ModelCapability.maxConcurrency` | Never enforced — neither the router nor `InlineRuntime` throttles. Your dispatch layer must apply the limit. |
| `Alternative.costMultiplier` / `.qualityDelta` | Planner / UI metadata only; they do not reorder alternatives. |
| `appliesWhen: whenBudgetBelow(...)` | Never matches. There is no budget source wired in, so this arm always evaluates false. |

With none of these in play, the default router's ranking is: pinned model →
preferred provider → tier match (if requested) → **first candidate in declared
order**. Ordering `getModels`' return is how you control routing today.

## Versioning (0.x SemVer)

Orchestral is pre-1.0. Per SemVer's 0.x rule, **minor releases may contain
breaking changes**. Pin a compatible range — `"~0.1"` (patch-only) is the safe
choice while the API stabilises. Breaking changes within 0.x are documented in
each package's `CHANGELOG.md`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
