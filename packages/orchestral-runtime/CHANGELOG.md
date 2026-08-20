# Changelog

All notable changes to `@orchestral/runtime` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [Unreleased]

### Breaking (0.x)

- **`InlineRuntime.reconcile()` is now `InlineRuntime.abandonOrphanedJobs()`.**
  Follows core's rename of the `Runtime` method; signature and behaviour are
  unchanged. The runtime never resumed anything here — it sweeps rows the dead
  process left `queued` / `running` to terminal `stale` and emits `job:stale`
  — and the old name suggested otherwise.

  ```diff
  - const stale = await runtime.reconcile()
  + const stale = await runtime.abandonOrphanedJobs()
  ```

- **Automatic `Alternative` fallback is now opt-in and off by default.**
  `InlineRuntimeInit.alternatives` selects `'off'` (default) or `'auto'`;
  previously every runtime redirected automatically. Under `'off'`, a dispatch
  whose capability cannot be served and that has a matching declared
  alternative fails with a structured `ALTERNATIVES_NOT_ENABLED` `JobError`
  whose `details.diagnostic` carries the capability, the unavailability reason,
  every applicable path (`id` / `description` / `targetPatternId`) and a hint
  for switching redirects on — so the host, or an LLM reading the failed tool
  result, chooses the degraded path deliberately instead of receiving it
  silently. With no applicable alternative the failure is unchanged
  (`NO_MODEL_FOR_CAPABILITY`), and a failed *model call* still rethrows the
  provider's own error rather than a routing-policy code. Hosts that want the
  previous behaviour pass `alternatives: 'auto'`.

- Follows core's removal of declaration-only metadata: the
  `job:alternative-selected` event no longer carries `qualityDelta`
  (`preserves` / `losses` remain), and the never-matching `'budget-below'`
  `appliesWhen` arm is gone from alternative evaluation.

### Changed

- **New dependency: `@orchestral/discovery`.** The `PatternSearchIndex` and
  `handleFindPattern` that back a subagent's `find_pattern` tool moved out of
  `@orchestral/core` into their own package; the runtime now pulls them from
  there. Behaviour is unchanged and no runtime API moved — hosts installing
  `@orchestral/runtime` get the new package transitively.

## [0.1.0] - 2026-08-16 — Initial public release

First public release. `@orchestral/runtime` is `InlineRuntime`, the in-process
reference implementation of `@orchestral/core`'s `Runtime` contract: it submits
jobs, resolves each pattern through a `CapabilityRouter`, and runs the resolved
`ModelCapability.call` in the caller's tick.

### Added

- **Job execution.** `submitJob` runs the dispatch to completion before the
  promise resolves — every job event has already fired by then, so subscribe
  from the `onJobCreated` init hook to observe progress.

- **Failure handling.** In-router retry, cross-pattern `Alternative` fallback
  when a capability cannot be served, and idempotency — an explicit
  `JobSpec.idempotencyKey`, or a canonical-JSON hash over what work to do
  (pattern id, input, resolved assets, session, step index). Routing metadata is
  deliberately excluded from the hash, and values that cannot be canonically
  serialised are rejected loudly rather than colliding silently.

- **Meta and agent execution.** Meta patterns run their compose function with a
  `ctx` that dispatches sub-steps back through the runtime; agent patterns run a
  tool loop over the catalog. Human-in-the-loop `ctx.askUser` calls await the
  host's injected handler with the job left `running`.

- **Sub-agent tool catalog.** `InlineRuntimeInit.catalogOptions`
  (`BuildCatalogDescriptorsOptions`) is forwarded to `buildCatalogDescriptors`
  when the catalog is assembled, so a host that has replaced the reference
  resolver can correct the slot-defaulting sentence in the `dispatch_pattern`
  description instead of shipping a claim about behaviour it no longer
  implements.

- **Diagnostics on failure.** When the router rejects a pinned model
  (`ModelExcludedError`), its structured diagnostic — candidate list, required
  tags, exclusion reason — travels on `JobError.details.diagnostic` instead of
  being dropped, so a host can surface why the pin never matched. The fallback
  `JobError.code` for a dispatch failure that carries no code of its own is
  `DISPATCH_EXECUTE_FAILED`.

- **Node requirement declared.** `engines.node >= 18` — the runtime uses
  `node:crypto` for idempotency hashing. `@orchestral/core` itself has no Node
  dependency and runs in renderer / worker / edge contexts.

### Known limitations

- **No durable queue.** The host's process lifecycle owns each job's lifetime.
  `reconcile()` abandons rather than resumes: after a crash, queued / running
  rows are marked terminal `stale` (emitting `job:stale`) — an in-process
  runtime cannot re-attach to lost work. A parked `ctx.askUser` prompt lives in
  memory and does not survive a restart either.

- **Agent resume is lossy.** An agent job can be resumed from a persisted
  `TranscriptStore`, but the replay is best-effort, not byte-exact: the
  transcript stores the agent-loop step projection (text + tool calls + usage),
  not raw provider messages. Resuming loses `tool_use_id` pairing (so the
  assistant's tool calls are dropped from the replayed history), reasoning
  blocks, and the original interleaving. A resumed agent picks up the gist of
  where it left off, not the exact prior conversation.

- **No throttling and no deadlines.** `ModelCapability.maxConcurrency` is not
  enforced, and there is no per-step timeout or job TTL. Cancellation is by
  `AbortSignal`; concurrency limits and wall-clock deadlines are the host's to
  impose.
