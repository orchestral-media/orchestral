# Orchestral

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**The orchestration substrate for local-first, BYOK media applications:
capability routing, in-process semantic fallback, and an asset-handle
protocol.**

You describe what a step needs (`text-to-image`, `image-to-video`,
`automatic-speech-recognition`, …), not which model to call. Orchestral routes
that capability to a model you supplied, retries inside the router, falls back
across *semantically equivalent* patterns when a capability has no model behind
it, and passes generated media between steps as opaque handles the host
resolves. It ships **no provider SDK and no API keys** — calling a model is a
~15-line adapter you write, over whichever SDK you already use.

## Packages

| Package | What it is |
| --- | --- |
| [`@orchestral/core`](packages/orchestral-core) | The vocabulary and contracts: `Pattern` / `ModelCapability` / `Alternative`, `Job` / `JobStore` / `Runtime`, the default capability router, and the pattern registry. No execution engine, no provider SDK. |
| [`@orchestral/patterns`](packages/orchestral-patterns) | The first-party pattern catalog: one atomic pattern per capability, plus meta and agent pipelines (storyboarding, script planning, idea-to-video, best-of-N selection, …) with their prompts inlined. |
| [`@orchestral/runtime`](packages/orchestral-runtime) | `InlineRuntime`, the in-process reference implementation of core's `Runtime`: submits jobs, dispatches through the router, handles retries, cross-pattern fallback and idempotency. No durable queue — the host owns each job's lifetime. |

All three are Apache-2.0 and released together.

## Quickstart

```sh
npm install @orchestral/core @orchestral/runtime @orchestral/patterns zod
```

`zod` (v4) is a peer dependency: pattern input/output schemas are zod schemas
on the public API, so your app and Orchestral must share one zod instance.

The end-to-end wiring — registry, model bridge, router, runtime, one dispatch —
is in **[`packages/orchestral-core/README.md`](packages/orchestral-core/README.md#minimal-example)**.
Two runnable versions of it live here:

- [`examples/atomic-hello-world`](examples/atomic-hello-world) — one atomic
  `text-to-image` dispatch, with the whole provider bridge in `src/ai-sdk-wiring.ts`.
- [`examples/agent-hello-world`](examples/agent-hello-world) — an agent-kind
  dispatch: an LLM tool-loop that picks and runs patterns.

```sh
pnpm install
pnpm --filter atomic-hello-world start   # needs OPENAI_API_KEY
```

## Repository layout

```
packages/orchestral-core/       @orchestral/core
packages/orchestral-patterns/   @orchestral/patterns
packages/orchestral-runtime/    @orchestral/runtime
examples/                       runnable hosts, ~50 lines each
scripts/smoke-dist.mjs          executes the built dist bundles end to end
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

## Versioning

`0.x`: minor versions may contain breaking changes, patch versions never do.
The three packages share one version line and are published together — pin the
exact trio you tested against. The `1.0` line will follow semver strictly.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`@orchestral/patterns` contains prompt text derived from a third-party MIT
project; the affected constants and the upstream license text are listed in
[`packages/orchestral-patterns/CREDITS.md`](packages/orchestral-patterns/CREDITS.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). For vulnerabilities, please use the
private channel in [SECURITY.md](SECURITY.md) rather than a public issue.
