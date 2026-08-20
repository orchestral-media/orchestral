# Orchestral

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**A TypeScript orchestration layer for media generation — text-to-image,
image-to-video, text-to-speech, speech recognition — built for local-first, BYOK
apps: capability routing, opt-in semantic fallback, and an asset-handle
protocol.**

You describe what a step needs (`text-to-image`, `image-to-video`,
`automatic-speech-recognition`, …), not which model to call. Orchestral routes
that capability to a model you supplied, retries inside the router, knows the
*semantically equivalent* paths a capability without a model could degrade
through (reporting them on failure by default; redirecting automatically is
opt-in), and passes generated media between steps as opaque handles the host
resolves. It ships **no provider SDK and no API keys** — calling a model is a
~15-line adapter you write, over whichever SDK you already use. Everything runs
in your process; there is no hosted control plane.

## How it relates to the AI SDK / LangChain

Different layers, and Orchestral expects you to keep using the others:

- **A provider SDK** (the Vercel AI SDK, an official vendor SDK) owns *one model
  call* — auth, request shape, streaming, transport retries. Your Orchestral
  `call` adapter is usually a dozen lines over one of these; the examples here
  use the AI SDK's `generateImage`.
- **An agent framework** (LangChain / LangGraph, the AI SDK's own tool loop)
  owns the *generic tool loop* — planning, memory, a graph of steps. Orchestral's
  agent patterns delegate the loop to whichever one you inject.
- **Orchestral** owns what neither covers for media: routing a *capability*
  rather than a model id, declaring semantically equivalent fallback paths for
  when no model serves that capability, and threading generated assets between
  steps as handles instead of raw ids.

## Quickstart

> **Not on npm yet** — 0.1.0 publishes shortly. Until then, clone this repo and
> run the examples.

```sh
npm install @orchestral/core @orchestral/runtime @orchestral/patterns zod
```

Two optional packages sit on top: `@orchestral/discovery` (the BM25 search
behind a `find_pattern` tool) and `@orchestral/agent` (the two agent patterns
plus an in-process `AgentRunImpl` over the AI SDK).

`zod` v4 (`>=4.3 <5`) is a peer dependency: pattern input/output schemas are zod
schemas on the public API, so your app and Orchestral must share one zod
instance.

Two runnable hosts live in this repo:

- [`examples/atomic-hello-world`](examples/atomic-hello-world) — one atomic
  `text-to-image` dispatch, with the whole provider bridge in `src/ai-sdk-wiring.ts`.
- [`examples/agent-hello-world`](examples/agent-hello-world) — an agent-kind
  dispatch: an LLM tool-loop that picks and runs patterns.

```sh
pnpm install
pnpm --filter atomic-hello-world start   # needs OPENAI_API_KEY
pnpm --filter atomic-hello-world test    # no key: same wiring, mock model
```

## Minimal example

Registry, model bridge, router, runtime, one dispatch — the whole surface:

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

const registry = new PatternRegistry()
registry.add(createTextToImagePattern())

// The seam you write: your provider SDK behind a ModelCapability envelope.
const model: ModelCapability = {
  capabilities: ['text-to-image'],
  provider: 'openai',
  modelId: 'gpt-image-1',
  inputs: ['text'],
  outputs: ['image'],
  tags: [],
  source: 'user',
  async call<I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> {
    const startedAt = Date.now()
    const { images } = await generateImage({
      model: openai.image('gpt-image-1'),
      prompt: (input as { prompt: string }).prompt,
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

const runtime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router: createDefaultCapabilityRouter({
    getModels: (cap) => (cap === 'text-to-image' ? [model] : []),
  }),
})

const job = await runtime.submitJob({
  patternId: 'text-to-image',
  input: { prompt: 'a watercolour fox in a misty forest' },
})
console.log(job.status, job.output) // 'done'  { modality: 'image', assets: [...] }
```

The annotated version of the same wiring is in
[`packages/orchestral-core/README.md`](packages/orchestral-core/README.md#minimal-example).

## What's in the box

`@orchestral/patterns` ships **25 patterns**: 10 atomic ones (one per capability
— `text-to-image`, `image-to-video`, `text-to-speech`,
`automatic-speech-recognition`, …) and 15 meta pipelines with their prompts
inlined (storyboarding, script planning, idea-to-video, best-of-N image
selection, …). The 2 agent patterns (an orchestrator and a long-form-video
director) live in the optional `@orchestral/agent` package.

The full table — kind, input slots, outputs, and the host operations each
pattern expects you to supply — is generated from the built package:
**[pattern catalog](packages/orchestral-patterns/README.md#catalog)**.

## The three seams

A host adopts Orchestral by satisfying three injection points. Two are
implementations you swap; the third is the call adapter:

| Seam | What it decides | What ships |
| --- | --- | --- |
| `JobStore` | where job rows live | `InMemoryJobStore` for dev/test; bring a durable one (e.g. SQLite-backed) for production |
| `CapabilityRouter` | which model answers a capability | `createDefaultCapabilityRouter`; you inject `getModels` and an optional enablement gate |
| `ModelCapability.call` | the actual provider invocation | nothing — this is the ~15-line adapter you write over your own SDK |

Agent patterns add a fourth seam, `AgentRunImpl`, which drives the inner LLM
tool-loop. It is `@alpha`; `@orchestral/agent` ships a reference implementation
over the AI SDK (`ai` as a peer dependency).

## Packages

| Package | What it is |
| --- | --- |
| [`@orchestral/core`](packages/orchestral-core) | The vocabulary and contracts: `Pattern` / `ModelCapability` / `Alternative`, `Job` / `JobStore` / `Runtime`, the default capability router, and the pattern registry. No execution engine, no provider SDK. |
| [`@orchestral/patterns`](packages/orchestral-patterns) | The first-party pattern catalog: one atomic pattern per capability, plus meta pipelines (storyboarding, script planning, idea-to-video, best-of-N selection, …) with their prompts inlined. |
| [`@orchestral/runtime`](packages/orchestral-runtime) | `InlineRuntime`, the in-process reference implementation of core's `Runtime`: submits jobs, dispatches through the router, handles retries, opt-in cross-pattern fallback and idempotency. No durable queue — the host owns each job's lifetime. |
| [`@orchestral/discovery`](packages/orchestral-discovery) | Optional. The LLM discovery layer: the BM25 `PatternSearchIndex` and the `find_pattern` tool handler. Core keeps the input contract; this package owns the searching. |
| [`@orchestral/agent`](packages/orchestral-agent) | Optional. The two agent patterns plus `createInProcessAgentRunImpl`, a reference `AgentRunImpl` over the AI SDK's tool loop (`ai` is a peer dependency). |
| [`dsh-plugin-orchestral`](packages/dsh-plugin-orchestral) | Experimental. A [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) plugin exposing registered patterns as dsh agent tools. A leaf package on its own version line — dsh is a dev preview, so breakage stops at the bridge. |

All packages are Apache-2.0. The `@orchestral/*` packages are released together
on one version line; `dsh-plugin-orchestral` versions independently.

## Honest limitations

This is 0.x. Each package README states its own edges rather than hiding them:

- **Agent resume is lossy.** The transcript stores a step projection, not raw
  provider messages: `tool_use` pairing and reasoning blocks are gone on resume —
  [runtime § Resume fidelity](packages/orchestral-runtime/README.md#resume-fidelity).
- **No durable queue.** `InlineRuntime` runs a job in the caller's tick, and
  `reconcile()` abandons crashed jobs as `stale` instead of resuming them;
  `ctx.askUser` parks in memory only —
  [runtime § Runtime semantics worth knowing](packages/orchestral-runtime/README.md#runtime-semantics-worth-knowing).
- **Deliverable metas need a multimedia backend you supply.** Six
  `MetaCommonDeps` operations (ffmpeg-shaped: concat, subtitles, background
  audio, …) are specified but not implemented here —
  [patterns § Deliverable metas](packages/orchestral-patterns/README.md#deliverable-metas).
- **One shipped fallback, and taking it is opt-in.** `image-to-image` → caption
  → re-render is the only `Alternative` in the first-party catalog, and
  `InlineRuntime` defaults to failing with the applicable paths listed rather
  than redirecting through them (`alternatives: 'auto'` turns redirects on) —
  [runtime § Alternative fallback is opt-in](packages/orchestral-runtime/README.md#alternative-fallback-is-opt-in),
  [core § Semantic fallback](packages/orchestral-core/README.md#semantic-fallback-alternative).

## Versioning

`0.x`: minor versions may contain breaking changes, patch versions never do.
The `@orchestral/*` packages share one version line and are published together —
pin the exact set you tested against. `dsh-plugin-orchestral` versions
independently against its dev-preview host. The `1.0` line will follow semver
strictly.

## Repository layout

```
packages/orchestral-core/        @orchestral/core
packages/orchestral-discovery/   @orchestral/discovery
packages/orchestral-patterns/    @orchestral/patterns
packages/orchestral-runtime/     @orchestral/runtime
packages/orchestral-agent/       @orchestral/agent
packages/dsh-plugin-orchestral/  dsh-plugin-orchestral (independent version line)
examples/                        runnable hosts, ~50 lines each
scripts/smoke-dist.mjs           executes the built dist bundles end to end
```

## Development

```sh
pnpm install
pnpm build        # tsdown bundle + tsc declarations + api-extractor rollup
pnpm test         # vitest, all packages and examples
pnpm typecheck
pnpm api:check    # public .d.ts surface vs the committed etc/*.api.md report
pnpm smoke:dist   # build, then run the published dist bundles end to end
pnpm docs:catalog # regenerate the pattern catalog table from the built dist
```

`pnpm api:check` failing means the public API changed. Review the diff, run
`pnpm api:update`, and commit the updated report alongside the change.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`@orchestral/patterns` contains prompt text derived from a third-party MIT
project; the affected constants and the upstream license text are listed in
[`packages/orchestral-patterns/CREDITS.md`](packages/orchestral-patterns/CREDITS.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). For vulnerabilities, please use the
private channel in [SECURITY.md](SECURITY.md) rather than a public issue.
