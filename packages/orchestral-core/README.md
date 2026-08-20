# @orchestral/core

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the three packages fit together.

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

> **Not on npm yet** — 0.1.0 publishes shortly. Until then, clone
> [the repo](https://github.com/orchestral-media/orchestral) and run the
> examples.

```sh
npm install @orchestral/core @orchestral/runtime @orchestral/patterns zod
```

`zod` v4 (`>=4.3 <5`) is a peer dependency — Pattern input/output schemas on the
public API are zod schemas, so your app and Orchestral must share a single zod
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
[`@orchestral/patterns`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-patterns),
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
needs an `AgentRunImpl` bridging to whatever agent SDK you use. The optional
[`@orchestral/agent`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-agent)
package ships a reference one over the Vercel `ai` SDK's tool loop, plus the two
first-party agent Patterns; the runnable
[`examples/agent-hello-world`](https://github.com/orchestral-media/orchestral/tree/main/examples/agent-hello-world)
wires it up. The agent seam is `@alpha` — expect it to move before 1.0.

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

The capability-level fallback in the tagline is declarative data on a pattern:
when the router reports the parent capability unsatisfiable, an `Alternative`
names another pattern that reaches a degraded but real result.

Declaring one does not make it fire. Whether a runtime redirects through it is
the runtime's policy, and `@orchestral/runtime` keeps automatic redirects
**off** by default (`InlineRuntimeInit.alternatives`), failing with the
applicable paths named instead — see
[runtime § Alternative fallback is opt-in](../orchestral-runtime/README.md#alternative-fallback-is-opt-in).
These types describe the paths; they do not promise one is taken:

```ts
// Shipped on `image-to-image` in @orchestral/patterns: with no image-to-image
// model in the catalog, caption the source and re-render from that text.
const viaCaption: Alternative<ImageToImageInput, ImageToImageOutput> = {
  id: 'via-caption',
  description: 'No image-to-image model is available: caption the source image, then re-render it.',
  appliesWhen: whenCapabilityUnavailable(), // pass ModelTags to require them
  via: {
    patternId: 'meta_image-to-image-via-caption',
    // The source image rides in the dispatch ctx, so only the intent is remapped.
    mapInput: (input) => ({ editPrompt: input.prompt, tier: 'preview' }),
    // Project field by field rather than casting the child envelope across.
    // `degraded` / `requestedSize` are deliberately not projected: the
    // degradation is already reported out-of-band by `job:alternative-selected`
    // (which carries `losses`), and the requested size belongs to the child's
    // own render, not the parent's contract.
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

The redirect target has to be registered for a redirect to happen — but only a
runtime that redirects can miss it: under `alternatives: 'auto'`, an absent
`meta_image-to-image-via-caption` throws `ALTERNATIVE_PATTERN_NOT_REGISTERED`
instead of falling back. Under the default `'off'` nothing is dispatched
through the path, so nothing has to be registered for the failure to name it.

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
  only as long as the process — after a crash, `abandonOrphanedJobs()` marks
  the job `stale`.
- `askUser.confirm` / `choose` / `form` cover the common widgets with typed
  question/answer contracts; `askUser.custom` passes an arbitrary payload for
  a bespoke widget.

## Pattern packages

A package that ships patterns says so in its `package.json`, under an
`"orchestral"` field:

```json
{
  "name": "orchestral-pattern-foo",
  "keywords": ["orchestral-pattern"],
  "orchestral": {
    "patterns": [
      { "id": "text-to-image", "kind": "atomic", "export": "createTextToImagePattern" },
      { "id": "meta_storyboard", "kind": "meta", "export": "createStoryboardMeta" },
      {
        "id": "meta_idea2video",
        "kind": "meta",
        "export": "createIdea2VideoMeta",
        "requiredOps": ["concatVideos"]
      }
    ]
  }
}
```

- **`export`** names a *factory* on the package entry point, not the pattern
  itself — patterns are built per registry, and some factories take host
  operations as their argument.
- **`id` / `kind`** are declared so a reader knows what the package contributes
  without running it; the loader verifies both against the built pattern, so a
  stale manifest fails loudly instead of registering something else. The kind
  prefix is part of the contract (`meta_*`, `agent_*`, bare capability id for
  atomic) — `inferNamespace` and the sub-agent recursion guard route on it.
- **`requiredOps`** names the host operations *that one pattern's* factory
  expects (the ffmpeg-shaped work a meta cannot do itself). It sits on the
  entry, not on the package: a package-wide list would make one ffmpeg-shaped
  meta enough to render the other two dozen patterns unloadable for a host with
  no ffmpeg, which is the opposite of what a manifest is for. A package-level
  `requiredOps` is refused rather than ignored — silently dropping a
  fail-closed op declaration is worse than either alternative.

Loading one is two lines plus however your host reads a JSON file:

```ts
import * as foo from 'orchestral-pattern-foo'
import pkg from 'orchestral-pattern-foo/package.json' with { type: 'json' }

const { registered, skipped } = registry.addFromManifest(pkg.orchestral, foo, ops)
```

Take a subset when that is all you can run — `only` picks patterns by id (an id
the manifest does not declare is an error, not a silent no-op), and
`missingOps` decides what a pattern whose ops you cannot supply does:

```ts
// Everything that needs nothing from the host; the rest is reported, not dropped.
const { registered, skipped } = registry.addFromManifest(
  pkg.orchestral, foo, undefined, { missingOps: 'skip' },
)
// skipped → [{ id: 'meta_idea2video', missingOps: ['concatVideos'] }]
```

`missingOps` defaults to `'throw'`: fail-closed is the right default because a
pattern quietly absent from the registry resurfaces hours later as a routing
miss. `'skip'` is how you say you meant it, and the result tells you what it
cost you.

**Discovery is a query, not a registration.** `npm view orchestral-pattern-foo
orchestral` prints the manifest without installing anything; the npm keyword
`orchestral-pattern`, the GitHub topic of the same name, and the
`orchestral-pattern-*` name convention are how packages are found. There is no
central index, no submission, and nothing to be approved by.

What this deliberately is *not*: a plugin framework. There is no lifecycle, no
sandbox, no version negotiation, no lazy activation. Two consequences worth
knowing before you rely on it:

- **Atomic within one call.** Every selected pattern is built and checked before
  any of them is registered, so a manifest error leaves the registry untouched —
  but loading the same package twice still throws from `register` itself.
- **The manifest is a declaration, not a permission boundary.** Reading it is
  safe; loading the package runs its code, exactly like any other import.

`@orchestral/patterns` is the first package to follow the convention — its
`"orchestral"` field covers all 25 shipped patterns, six of which declare the
ffmpeg-shaped ops they need. `@orchestral/agent` carries its own for the two
agent patterns.

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
| See why routing picked (or refused) a model | `router.explain?.(...)` + `formatRoutingExplanation` |
| Load someone else's pattern package | `registry.addFromManifest` (see above) |

Everything else on the barrel (asset-ledger primitives, catalog rendering and
dispatch helpers such as `buildCatalogDescriptors` / `resolveDispatchTarget`,
schema derivation utilities) exists for hosts that expose the catalog to an LLM
as tools. Adopt those incrementally — none are needed for hello-world.

Core renders the two fixed router tools and validates calls against their
schemas (`FindPatternInputSchema`, `DispatchPatternInputSchema`), but it does
**not** search. Answering a `find_pattern` call — the BM25 index over the
registry plus the `handleFindPattern` handler — lives in
[`@orchestral/discovery`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-discovery),
because which retrieval algorithm ranks your catalog is a product decision, not
a contract. `@orchestral/runtime` already depends on it; reach for it directly
only if you drive the agent loop yourself.

## Routing knobs in 0.x

The default router's selection order is: pinned model → preferred provider →
tier match (if requested) → **first surviving candidate**. What "first" means is
the ranking, and the ranking is yours: `ResolveContext.rankedModels` when the
caller supplies one, otherwise the enablement order from `getCapabilityOrder`,
and only failing both does `getModels`' own return order decide. Use
`router.explain?.(capability)` to see which of the three is in play for a given
call rather than inferring it.

The one soft knob is `ModelCapability.tier`: it is read **only** when the
caller passes `ResolveContext.tier`, and then best-effort — the first tier
match wins, otherwise resolution falls through to the remaining candidates.
There is deliberately no cost or latency metadata on the public types: media
generation cost is not reliably computable up front, so anything cost-aware
belongs in your own `getModels` ordering or a custom router.

Those knobs stack, and a wrong model looks exactly like a wrong catalog from
`resolve`'s return value alone. `explain` dumps the whole decision — every
model considered, the filter that dropped each one, the surviving fallback
order, and what `resolve` would do — and `formatRoutingExplanation` prints it:

```text
routing: text-to-image tags=[fast]
satisfiable: yes
resolve: fal:flux (by first-candidate)
context: excludeModel=[openai:gpt-image-1]
ranking: enablement default (getCapabilityOrder) [fal:flux, replicate:flux]
candidates: 2 kept of 3
  1. fal:flux tier=premium tags=[fast]
  2. replicate:flux tags=[fast]
  -  openai:gpt-image-1 tags=[fast] dropped: excluded-model
```

`explain` is **optional** on the `CapabilityRouter` interface — implementing
the interface directly stays a two-method job — so call it as
`router.explain?.(capability, tags, ctx)`.

## Versioning (0.x SemVer)

Orchestral is pre-1.0. Per SemVer's 0.x rule, **minor releases may contain
breaking changes**. Pin a compatible range — `"~0.1"` (patch-only) is the safe
choice while the API stabilises. Breaking changes within 0.x are documented in
each package's `CHANGELOG.md`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
