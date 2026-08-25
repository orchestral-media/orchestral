# @orchestral/runtime

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the three packages fit together.

The in-process `InlineRuntime` for Orchestral — the reference implementation of
`@orchestral/core`'s `Runtime` contract.

`InlineRuntime` submits jobs, dispatches patterns through a `CapabilityRouter`,
and runs the resolved `ModelCapability.call` synchronously in the caller's tick.
It handles the model fallback walk, idempotency, and — when the host opts in —
same-model transient retry and cross-pattern `Alternative` fallback; see
[Retry and fallback are two budgets](#retry-and-fallback-are-two-budgets) and
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
- **A failed dispatch is a resolved Job, not a rejection.** Once a row exists,
  a provider failure, a middleware reject, or a cancel lands on it as
  `status: 'error'` (with `error` set) or `'cancelled'`, and the promise
  resolves with that row — read `job.status`. It rejects only when the request
  never became a job: an unregistered `patternId`, an input the idempotency key
  cannot be derived from, a store that refuses the INSERT.
- **`abandonOrphanedJobs()` is the whole crash story.** Call it on start: rows
  the dead process left `queued` / `running` go terminal `stale` (emitting
  `job:stale`). An in-process runtime has nothing left to re-attach to.
- **Human-in-the-loop parks in memory.** `ctx.askUser` awaits the injected
  `askUser` handler with the job left `running`; the park does not survive a
  process restart.
- **Node only.** The runtime uses `node:crypto` (idempotency hashing), so it
  requires a Node host (`engines.node >= 18`). `@orchestral/core` itself has
  no Node dependency and runs in renderer / worker / edge contexts.
- **Events first, log lines only for what has no job.** Anything that happens
  to a job is a `JobEvent` on its stream — including every model the fallback
  walk gives up on (`job:model-fallback`, carrying that hop's own error and
  attempt count) — and the runtime never writes to the console for it; the few
  things with no job to report on (a host callback that threw, a transcript
  append that failed) go to `InlineRuntimeInit.logger`, a `DiagnosticsLogger`
  that defaults to the console and that `silentDiagnosticsLogger` turns off.
- **Every output is held to its schema.** At the dispatch exit, an atomic or
  meta output that `pattern.outputs` rejects fails the job with
  `OUTPUT_SCHEMA_MISMATCH`; `error.details` names the pattern and the zod
  issues and carries `rawOutput`, since the call was already paid for. A
  conforming output is returned as the adapter produced it — unknown keys and
  all — never zod's parsed copy. `InlineRuntimeInit.outputValidation: 'off'`
  skips the check, for a migration window over adapters the host does not
  control; there is no warn mode, because a mismatch belongs to a job and the
  runtime does not log what it can fail.

## Retry and fallback are two budgets

Atomic dispatch has two ways to recover from a failed `model.call`, and they are
bounded separately because they answer different questions.

**The fallback walk** answers *"this provider is not going to work — who else?"*
A model the dispatch gives up on is added to `ResolveContext.excludeModel` and
the next hop resolves a different candidate. Depth is
`InlineRuntimeInit.fallbackDepth` (default 3), or `ResolveContext.fallbackDepth`
per dispatch — a host with a configured chain sets it to
`rankedModels.length - 1` so the whole order gets walked and no further.

**Transient retry** answers *"that was a blip — same provider, once more?"* It
calls the same model again and is **off unless you wire it**:

```ts
const runtime = new InlineRuntime({
  store, registry, router,
  transientRetry: {
    // Your provider SDK's error shapes, not ours.
    isTransient: (err) => {
      const status = (err as { status?: number }).status
      return status === 429 || status === 503
    },
    // Core's RetryPolicy — maxAttempts counts TOTAL calls against one model.
    policy: { kind: 'exponential', maxAttempts: 3, baseMs: 500, maxMs: 5_000 },
  },
})
```

Neither budget can spend the other's. Three retries against one provider still
cost a single fallback hop; a five-model chain still gives every model the same
attempt count. Backoff honours `ctx.signal` — cancelling mid-backoff rejects
immediately rather than after the delay elapses.

Why off by default, and why no built-in classifier: media generation calls run
for tens of seconds and cost real money, so guessing wrong is expensive in
*both* directions. A 429 read as fatal drops the dispatch onto a pricier or
worse candidate. A content rejection read as a blip pays for the same refusal
three times. Only code holding your provider SDK's own error shapes can tell
those apart, so the judgement is yours; without `transientRetry` nothing is
transient and every failure excludes its model immediately.

`isTransient` receives the capability, the `provider:modelId`, and the 1-based
attempt number, so a single runtime can still answer differently for a cheap
image call and an expensive video one.

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
          "targetPatternId": "meta_image-to-image-via-caption",
          "preserves": ["style"],
          "losses": ["subject-identity", "composition", "mask-guidance"]
        }
      ],
      "hint": "Construct InlineRuntime with `alternatives: 'auto'` …"
    }
  }
}
```

`code` is stable and `details.diagnostic` is machine-readable, so a subscriber
can offer the degraded path as a choice, and an LLM reading the failed tool
result can dispatch `targetPatternId` itself. Each entry carries the
alternative's declared `preserves` / `losses` verbatim, so the trade-off can
be put to a user straight off the refusal, without a lookup back into the
registry. With **no** applicable alternative the failure is unchanged: the
router's own `NO_MODEL_FOR_CAPABILITY`.

With `alternatives: 'auto'`, a redirect announces itself with
`job:alternative-selected` (carrying that same `preserves` / `losses`) before
the target dispatches, so a degraded completion is still distinguishable from a
primary one.

Two boundaries worth knowing:

- The switch is per runtime instance, not per job. A host that wants
  degradation on some surfaces only constructs two runtimes.
- The other fall-through into alternatives — a model *was* resolved and its
  call failed — is disabled by the same switch, but does **not** produce
  `ALTERNATIVES_NOT_ENABLED`. The provider error (auth, invalid input, network)
  is the actionable one there, so it is rethrown verbatim rather than restated
  as a routing-policy code.

## Refused agent tool calls are observable

An agent loop can name any registered pattern id — with two-stage discovery it
only ever sees `find_pattern` and `dispatch_pattern`, so the catalog cannot
express "you may not call X". Three guards enforce that at dispatch time, in
order: the ancestor cycle check, the `loop.toolPatternIds` allowlist, and the
default sub-agent blocklist.

A refusal is **not** a failed job. The guard returns a structured tool-result so
the loop reads it and picks a different `pattern_id`; the job still settles
`done` with `error: null`, and the refused call is not counted in
`AgentDispatchEnvelope.totalToolUseCount` — nothing was brokered. Throwing
instead would be stream-fatal for the whole agent run, which is a large price
for one hallucinated id.

That leaves the attempt visible only inside the model's context window, so each
guard also fans out `job:tool-rejected` on the agent job's stream, before the
refusal is handed back:

```ts
runtime.subscribe(jobId, (ev) => {
  if (ev.type !== 'job:tool-rejected') return
  // ev.patternId       — the refused target
  // ev.callerPatternId — the agent that asked for it
  switch (ev.code) {
    case 'SUBAGENT_TOOL_OUT_OF_SCOPE':
      // ev.allowlist — the EFFECTIVE allowlist the call was judged against.
      // For an async agent that is toolPatternIds ∩ asyncToolPatternIds.
      break
    case 'CIRCULAR_AGENT_TOOL':
      // ev.ancestors — the dispatch chain the call would have closed.
      break
    case 'SUBAGENT_BLOCKED':
      // ev.matched — 'prefix' | 'id', which half of the blocklist hit.
      break
  }
})
```

`ev.code` is the same code the model read in its tool-result, so an event joins
to the verdict that caused it. Two boundaries:

- **The event fires on the agent's own job**, which for a nested sub-agent is a
  child job id the caller never sees. Auditing a whole dispatch tree means
  subscribing from `onJobCreated`, not to the root job alone.
- **Rejections are not written to the `TranscriptStore`.** The only replayable
  message kind is `tool-result`, so recording one would add `role: 'tool'` turns
  to the resume seed and change what a resumed model sees. The event stream
  carries the audit trail; resume stays as described below.

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
