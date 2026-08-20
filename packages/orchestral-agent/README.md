# @orchestral/agent

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

**Agent support is an optional extension, not part of the core.** Nothing in
`@orchestral/core`, `@orchestral/runtime` or `@orchestral/patterns` depends on
this package; a host that never runs an LLM loop never installs it.

What it ships is exactly two things:

- **Two first-party `AgentPattern`s** — `agent_long-form-video` (a novel →
  multi-event video director, with its SKILL bodies inlined) and
  `agent_orchestrator` (a general open-ended media orchestrator). Both compose
  the atomic + meta catalog in [`@orchestral/patterns`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-patterns)
  by pattern id.
- **A reference `AgentRunImpl`** — `createInProcessAgentRunImpl`, which drives
  the ai-sdk `ToolLoopAgent` in this process and bridges its tool calls back
  into the runtime.

```ts
import { PatternRegistry } from '@orchestral/core'
import { InlineRuntime } from '@orchestral/runtime'
import {
  createOrchestratorAgent,
  createInProcessAgentRunImpl,
} from '@orchestral/agent'

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
| First-party agent Patterns + a runner that fills the seam | **this package** |

A production host (desktop app, server) typically keeps the patterns and writes
its own `AgentRunImpl` — one that runs the loop in a worker over IPC, persists
message history, and grants host tools. The interface is the same either way;
`createInProcessAgentRunImpl` is the zero-infrastructure version of it.

## Why `ai` is a peer dependency

Orchestral ships no provider SDK — the host brings its own, along with its own
key. The reference runner is written against the Vercel AI SDK's
`ToolLoopAgent`, so `ai` is declared as a **peer** dependency (`^7`) rather than
a bundled one:

- the model instance the host builds (`openai('gpt-4o')`) and the loop that
  consumes it must come from the *same* copy of `ai`; a bundled second copy
  would fail at the type level and misbehave at runtime;
- the host stays in charge of the SDK version, its provider packages, and its
  credentials — none of which a pattern catalog has any business pinning.

Install it alongside this package:

```sh
pnpm add @orchestral/agent ai @ai-sdk/openai
```

`zod` (`>=4.3 <5`) is a peer for the same reason it is one in
`@orchestral/patterns`: the schemas here must be the host's zod instance.

## Runnable example

[`examples/agent-hello-world`](https://github.com/orchestral-media/orchestral/tree/main/examples/agent-hello-world)
is the whole thing end to end — registry → router → runtime → one agent
dispatch — in about a hundred lines of host wiring, with a smoke test that runs
the loop offline against a mock LLM (no API key).

> **`@alpha`.** The agent seam (`AgentRunImpl`) is still evolving; a 0.1 → 0.2
> reshape of these exports is not a breaking change under this repo's 0.x
> policy.

## License

Apache-2.0. Some prompt text is derived from third-party work under the MIT
license — see [`CREDITS.md`](./CREDITS.md) and [`NOTICE`](./NOTICE).
