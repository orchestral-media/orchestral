# @orchestral/dsh-plugin

> **Experimental.** Not part of the orchestral public API contract. Expect breaking changes at any version.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) bundle that supplies
[orchestral](https://github.com/orchestral-media/orchestral)'s media-generation Patterns to a dsh agent as
ordinary tools. orchestral does the capability routing, model fallback, idempotency, and asset-handle
bookkeeping; dsh's agent loop does the reasoning.

## Architecture constraint: this is a leaf

**Nothing in orchestral depends on this package, and nothing ever will.**

`@orchestral/core`, `@orchestral/runtime`, and `@orchestral/patterns` do not know dsh exists. This bridge
depends on them, and on dsh, and the arrow never reverses. It ships on its own version line
(`0.0.1`, unrelated to the `@orchestral/*` versions) for one reason: **dsh is a developer preview whose
README promises compatibility-breaking changes.** When a dsh release breaks the bridge, only the bridge
is repaired — the orchestral packages, their consumers, and their published API reports are untouched.

Treat any pressure to "just add a small dsh-shaped hook in core" as the bug it is.

## Compatibility

| | |
|---|---|
| Verified against | `@deepseek-ai/dsh@0.1.0-rc.7`, `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-tools@0.1.0-rc.7` |
| dsh status | **developer preview — breaking changes expected** |
| dsh dependencies | pinned exactly, not caret-ranged, on purpose |

## What it does

On load, the plugin walks the `PatternRegistry` it was handed and registers one dsh tool per Pattern that
orchestral's own exposure rules admit for the configured surface:

- Visibility comes from `resolveExposure(pattern.exposure)` in `@orchestral/core` — the only correct way
  to read `exposure`, since it handles both the `'tool' | 'agent-tool' | 'no-tool'` shorthand and the
  per-surface object form (which fails closed on unnamed surfaces). A Pattern marked `'no-tool'` is
  host-direct only and never becomes a dsh tool.
- Each tool's `parameters` is the Pattern's own zod input schema projected to JSON Schema — the same
  contract `@orchestral/core` hands every other host. The plugin registers a raw dsh `ToolDefinition`
  rather than going through `defineTool`, because round-tripping through dsh's `ParameterSchemaSpec` DSL
  would drop constraints the DSL cannot express.
- A tool call resolves any declared asset slots, then calls `runtime.submitJob`.
- A dispatch that fails is raised as a tool error. orchestral resolves `submitJob` with the failed Job
  (`status: 'error'` plus a structured `JobError`); dsh's one channel for a failed call is a throw, so the
  bridge re-raises the `JobError` as `CODE: message` and dsh normalizes it into an `isError` result the
  model can read and re-plan from. A cancelled dispatch surfaces the same way, under `CANCELLED`.
- **The result is always `sanitizeToolOutput(projectToolOutputForModel(job.output))`.** The projection is
  orchestral's verifiable no-assetId boundary: produced assets reach the model as an opaque handle plus an
  `asset://` URI, never a real `assetId` or a signed provider URL. The sanitizer then scrubs any `data:`
  URL or raw binary run a Pattern accidentally left in its output, so one bad field cannot burn the
  agent's context window.

Registrations are reversible: they all live in one `ctx.effect()`, so an unload or HMR reload unwinds
every tool together.

## The plugin does not build a Runtime

It consumes one. A `Runtime` needs a `JobStore`, a `CapabilityRouter`, provider credentials, and a
`resolveCtxProvider` — deployment decisions a plugin has no business guessing. The host constructs an
`InlineRuntime` and hands it over, live, through config.

## Usage

Because the config carries live objects, the host mounts a small provider plugin that publishes them as an
`orchestralHost` service, and this bundle's patch layer reads them with `!!js` config expressions.

**1. The host provider plugin:**

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import { PatternRegistry } from '@orchestral/core'
import { InlineRuntime } from '@orchestral/runtime'
import { createTextToImagePattern } from '@orchestral/patterns'

export default class OrchestralHost extends Service {
  runtime: InlineRuntime
  registry: PatternRegistry

  constructor(ctx: Context) {
    super(ctx, 'orchestralHost')
    this.registry = new PatternRegistry()
    this.registry.register(createTextToImagePattern())
    this.runtime = new InlineRuntime({
      store: /* your JobStore */,
      registry: this.registry,
      router: /* your CapabilityRouter */,
    })
  }
}
```

**2. Install this bundle into a profile:**

```sh
dsh plugin --profile demo add @orchestral/dsh-plugin
```

The bundle's `cordis.patch.yml` inserts a row that declares `inject: [orchestralHost]`, so it stays inert
until your provider is mounted, then activates with the runtime and registry wired in.

**3. Boot:**

```sh
dsh --profile demo --dump-config   # inspect the composed layer
dsh --profile demo
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `runtime` | *(required)* | A constructed orchestral `Runtime`, e.g. an `InlineRuntime`. |
| `registry` | *(required)* | The `PatternRegistry` whose exposed Patterns become tools. |
| `surface` | `'chatTurn'` | Which orchestral exposure surface this dsh registry represents. `'agentLoop'` additionally admits `'agent-tool'` Patterns and suits a subagent-scoped mount. |
| `toolNamePrefix` | `''` | Prepended to every tool name. PatternIds are already valid LLM tool names by design; set a prefix only to avoid collisions with other plugins. |
| `timeoutMs` | *(none)* | Per-call deadline, enforced by dsh's timeout policy. |
| `resolveJobContext` | *(none)* | `(args) => { sessionId?, assetContextId?, assetEvents? }`. Supplies the host-owned asset ledger a call's `input.references` handles resolve against. Patterns with no `assetNeeds` never consult it. |

## Known limitations

- **No mid-flight cancellation.** orchestral's `submitJob` takes no `AbortSignal`, and correlating a
  `jobId` early requires `InlineRuntimeInit.onJobCreated`, which is set when the host *constructs* the
  runtime — deliberately outside this plugin's reach. The plugin refuses to dispatch a call whose
  `exec.signal` is already aborted; a host that needs true cancellation wires `onJobCreated` to
  `runtime.cancelJob` itself.
- **No UI cards.** `presentCall` / `presentResult` are not implemented, so calls render with dsh's generic
  card.

## License

Apache-2.0. Note that dsh itself is MIT and `@deepseek-ai/dsh-tools` is BSD-3-Clause.
