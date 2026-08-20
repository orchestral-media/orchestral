# @orchestral/agent

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

**Agent support is an optional extension, not part of the core.** Nothing in
`@orchestral/core`, `@orchestral/runtime` or `@orchestral/patterns` depends on
this package; a host that never runs an LLM loop never installs it.

What it ships is exactly one thing: **two first-party `AgentPattern`s.**

- `agent_long-form-video` — a novel → multi-event video director, with its SKILL
  bodies inlined.
- `agent_orchestrator` — a general open-ended media orchestrator.

Both compose the atomic + meta catalog in
[`@orchestral/patterns`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-patterns)
by pattern id. Both are pure declarations: prompts, schemas, tool lists. **No
loop implementation and no provider SDK ships here** — the `AgentRunImpl` that
drives the LLM tool-loop is yours to inject (see below).

```ts
import { PatternRegistry } from '@orchestral/core'
import { InlineRuntime } from '@orchestral/runtime'
import { createOrchestratorAgent } from '@orchestral/agent'
import { createInProcessAgentRunImpl } from './agent-runner' // yours

const registry = new PatternRegistry()
registry.add(createOrchestratorAgent())
// …plus the atomic + meta patterns its loop.toolPatternIds names.

const runtime = new InlineRuntime({
  store,
  registry,
  router,
  // Injecting a runner is what turns the runtime's agent seam on.
  agentRunImpl: createInProcessAgentRunImpl({
    resolveModel: () => openai('gpt-4o'), // BYOK — your key, your instance
  }),
})
```

A host can also register both patterns straight from the package manifest,
without hand-written wiring:

```ts
import pkg from '@orchestral/agent/package.json' with { type: 'json' }
import * as agent from '@orchestral/agent'

registry.addFromManifest(pkg.orchestral, agent) // no requiredOps
```

## Where this sits relative to the runtime seam

The agent machinery itself is **not** here. `@orchestral/core` owns the contract
types (`AgentPattern`, `agentInputSchema`, the agent finish envelope) and
`@orchestral/runtime` owns `dispatchAgent` — the code that builds the tool
catalog, resolves asset handles for the child context, brokers `complete_task`,
and composes the finish envelope.

That seam is **dormant by default**: `dispatchAgent` needs an `AgentRunImpl`,
and a runtime constructed without one simply cannot run an `AgentPattern`. So
the split is:

| Concern | Lives in |
| --- | --- |
| `AgentPattern` type, finish envelope, `agentInputSchema` | `@orchestral/core` |
| `dispatchAgent`, the `AgentRunImpl` interface, tool catalog + handle plumbing | `@orchestral/runtime` (inert until a runner is injected) |
| First-party agent Patterns | **this package** |
| The runner that fills the seam | **your host** — reference implementation in [`examples/agent-hello-world`](https://github.com/orchestral-media/orchestral/tree/main/examples/agent-hello-world) |

## Why no loop implementation ships here

Same iron rule as `ModelCapability.call`: **Orchestral ships no provider SDK,
and no agent framework either.** `AgentRunImpl` is a seam the library declares
and the host fills — the agent-side twin of the `call` adapter you already write
over your own SDK.

Shipping a loop would mean this package picking your agent framework (Vercel AI
SDK? LangGraph? your own worker protocol?) and dragging its SDK into every
install, including the installs of hosts that only want the two declarative
patterns above. So the loop stays out, and the interface stays small:

```ts
interface AgentRunImpl {
  run(args): Promise<{ text: string; usage?: { totalTokens?: number } }>
}
```

The runtime hands `run()` the system prompt, the seed messages, the tool
descriptors (already built from `loop.toolPatternIds`, finish tool included), an
`onToolCall` callback that recurses back into `runtime.submitJob`, and an abort
signal. All a runner does is drive some tool loop over that and return the final
text. The four rules that the signature cannot express — and that fail silently
when broken — are documented on the interface itself in
[`@orchestral/runtime`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-runtime).

**A copy-pasteable reference implementation lives in
[`examples/agent-hello-world/src/agent-runner.ts`](https://github.com/orchestral-media/orchestral/tree/main/examples/agent-hello-world/src/agent-runner.ts)**
— ~150 lines over the Vercel AI SDK's `ToolLoopAgent`, with the two host-shaped
seams (`resolveModel`, `stopWhen`) left injected. The example is the whole path
end to end — registry → router → runtime → one agent dispatch — with a smoke
test that runs the loop offline against a mock LLM (no API key). Copy that file
into your host and adjust, or write your own against a different framework.

A production host (desktop app, server) writes its own anyway — one that runs
the loop in a worker over IPC, persists message history, and grants host tools.
The interface is the same either way.

## Dependencies

This package has **no provider-SDK dependency at all**. Its only peer is `zod`
(`>=4.3 <5`), for the same reason it is one in `@orchestral/patterns`: the
schemas here must be the host's zod instance.

```sh
pnpm add @orchestral/agent zod
```

Whatever SDK your runner uses (`ai`, `@ai-sdk/openai`, …) is installed by your
host, at your chosen version — the model instance you build and the loop that
consumes it then trivially come from the same copy.

> **`@alpha`.** The agent seam (`AgentRunImpl`) is still evolving; a 0.1 → 0.2
> reshape of these exports is not a breaking change under this repo's 0.x
> policy.

## License

Apache-2.0. Some prompt text is derived from third-party work under the MIT
license — see [`CREDITS.md`](./CREDITS.md) and [`NOTICE`](./NOTICE).
