# @orchestral/runtime

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the three packages fit together.

The in-process `InlineRuntime` for Orchestral — the reference implementation of
`@orchestral/core`'s `Runtime` contract.

`InlineRuntime` submits jobs, dispatches patterns through a `CapabilityRouter`,
and runs the resolved `ModelCapability.call` synchronously in the caller's tick.
It handles in-router retries, idempotency, and — when the host opts in —
cross-pattern `Alternative` fallback; see
[Alternative fallback is opt-in](#alternative-fallback-is-opt-in).
There is no durable queue — the host's lifecycle owns each job's
lifetime. Resuming an agent job across processes requires the host to inject a
persistent `TranscriptStore`, and the replay is lossy; see
[Resume fidelity](#resume-fidelity).

```ts
import { InlineRuntime } from '@orchestral/runtime'

const runtime = new InlineRuntime({ store, registry, router })
const job = await runtime.submitJob({ patternId: 'text-to-image', input })
```

See [`@orchestral/core`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-core)
for the full picture — the contracts, the default router, and an end-to-end
example.

## Runtime semantics worth knowing

- **`submitJob` resolves at terminal.** The inline runtime runs the dispatch
  to completion before the promise resolves, so every job event has already
  fired. Subscribe from the `onJobCreated` init hook to observe progress;
  `await submitJob(...)` then `subscribe(...)` observes nothing.
- **`abandonOrphanedJobs()` is the whole crash story.** Call it on start: rows
  the dead process left `queued` / `running` go terminal `stale` (emitting
  `job:stale`). An in-process runtime has nothing left to re-attach to.
- **Human-in-the-loop parks in memory.** `ctx.askUser` awaits the injected
  `askUser` handler with the job left `running`; the park does not survive a
  process restart.
- **Node only.** The runtime uses `node:crypto` (idempotency hashing), so it
  requires a Node host (`engines.node >= 18`). `@orchestral/core` itself has
  no Node dependency and runs in renderer / worker / edge contexts.

## Alternative fallback is opt-in

A Pattern can declare `alternatives` — cross-pattern fallback paths, each with
an `appliesWhen` condition and a redirect target. **The runtime does not take
them unless you ask it to.** The default is `alternatives: 'off'`:

```ts
// Default: a capability the router cannot serve fails the job.
const runtime = new InlineRuntime({ store, registry, router })

// Opt in: the runtime redirects through the first matching alternative.
const degrading = new InlineRuntime({ store, registry, router, alternatives: 'auto' })
```

Why off: swapping in a semantically different path is a product decision, not a
runtime one. A caller who asked for an identity-preserving edit and silently got
a re-render from a caption received a *different answer*, not a retry — and only
the host knows whether that trade is acceptable for the surface it is serving.
Comparable orchestration libraries surveyed at the time of writing all fail
explicitly here and leave the substitution to the caller; so does this one, by
default.

What you get instead is a failure that names the paths you turned down. When the
capability cannot be served **and** a declared alternative's `appliesWhen`
matches, the job fails with a structured `JobError`:

```jsonc
{
  "code": "ALTERNATIVES_NOT_ENABLED",
  "message": "ALTERNATIVES_NOT_ENABLED: image-to-image cannot be served (reason=no-model-in-catalog) …",
  "details": {
    "diagnostic": {
      "capability": "image-to-image",
      "reason": "no-model-in-catalog",
      "alternatives": [
        {
          "id": "via-caption",
          "description": "No image-to-image model is available: caption the source image, then re-render it from that caption plus the edit instruction. …",
          "targetPatternId": "meta_image-to-image-via-caption"
        }
      ],
      "hint": "Construct InlineRuntime with `alternatives: 'auto'` …"
    }
  }
}
```

`code` is stable and `details.diagnostic` is machine-readable, so a subscriber
can offer the degraded path as a choice, and an LLM reading the failed tool
result can dispatch `targetPatternId` itself. With **no** applicable
alternative the failure is unchanged: the router's own
`NO_MODEL_FOR_CAPABILITY`.

With `alternatives: 'auto'`, a redirect announces itself with
`job:alternative-selected` (carrying the alternative's `preserves` / `losses`)
before the target dispatches, so a degraded completion is still distinguishable
from a primary one.

Two boundaries worth knowing:

- The switch is per runtime instance, not per job. A host that wants
  degradation on some surfaces only constructs two runtimes.
- The other fall-through into alternatives — a model *was* resolved and its
  call failed — is disabled by the same switch, but does **not** produce
  `ALTERNATIVES_NOT_ENABLED`. The provider error (auth, invalid input, network)
  is the actionable one there, so it is rethrown verbatim rather than restated
  as a routing-policy code.

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
