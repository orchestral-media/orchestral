# @orchestral/runtime

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

The in-process `InlineRuntime` for Orchestral — the reference implementation of
`@orchestral/core`'s `Runtime` contract.

`InlineRuntime` submits jobs, dispatches patterns through a `CapabilityRouter`,
and runs the resolved `ModelCapability.call` synchronously in the caller's tick.
It handles in-router retries, cross-pattern `Alternative` fallback, and
idempotency. There is no durable queue — the host's lifecycle owns each job's
lifetime. Resuming an agent job across processes requires the host to inject a
persistent `TranscriptStore`, and the replay is lossy; see
[Resume fidelity](#resume-fidelity).

```ts
import { InlineRuntime } from '@orchestral/runtime'

const runtime = new InlineRuntime({ store, registry, router })
const job = await runtime.submitJob({ patternId: 'text-to-image', input })
```

See [`@orchestral/core`](https://www.npmjs.com/package/@orchestral/core) for the
full picture — the contracts, the default router, and an end-to-end example.

## Runtime semantics worth knowing

- **`submitJob` resolves at terminal.** The inline runtime runs the dispatch
  to completion before the promise resolves, so every job event has already
  fired. Subscribe from the `onJobCreated` init hook to observe progress;
  `await submitJob(...)` then `subscribe(...)` observes nothing.
- **`reconcile()` abandons, it does not resume.** After a crash, queued /
  running rows are marked terminal `stale` (emitting `job:stale`) — an
  in-process runtime cannot re-attach to lost work.
- **Human-in-the-loop parks in memory.** `ctx.askUser` awaits the injected
  `askUser` handler with the job left `running`; the park does not survive a
  process restart.
- **Node only.** The runtime uses `node:crypto` (idempotency hashing), so it
  requires a Node host (`engines.node >= 18`). `@orchestral/core` itself has
  no Node dependency and runs in renderer / worker / edge contexts.

## Resume fidelity

An agent job can be resumed from a persisted transcript (`TranscriptStore`), but
the replay is **best-effort, not byte-exact** — the transcript stores the
agent-loop step projection (text + tool calls + usage), not raw provider
messages. Re-seeding a loop from it loses:

- **`tool_use_id` pairing.** Tool results cannot be matched back to the
  `tool_use` block that produced them, so the assistant's tool calls are dropped
  from the replayed history.
- **Reasoning blocks.** Extended-thinking content is not captured and is gone
  on resume.
- **Interleaving.** The original `assistant: text + tool_use → user:
  tool_result` structure is flattened into separate plain turns.

Practically: a resumed agent picks up the gist of where it left off, not the
exact prior conversation. Budget for the model re-deriving context, and do not
rely on resume for work where an exact continuation is required. A future
raw-message capture will replace this projection; until then this is the
contract.

## Versioning (0.x SemVer)

Pre-1.0: minor releases may include breaking changes. Pin `"~0.1"` and check the
[`CHANGELOG.md`](./CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
