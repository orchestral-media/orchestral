# Changelog

All notable changes to `@orchestral/runtime` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-21 — Initial public release

First public release. `@orchestral/runtime` is `InlineRuntime`, the in-process
reference implementation of `@orchestral/core`'s `Runtime` contract: it submits
jobs, resolves each pattern through a `CapabilityRouter`, and runs the resolved
`ModelCapability.call` in the caller's tick.

### Added

- **Job execution.** `submitJob` runs the dispatch to completion before the
  promise resolves — every job event has already fired by then, so subscribe
  from the `onJobCreated` init hook to observe progress.

- **Failure handling.** A model fallback walk, opt-in same-model transient
  retry (see below), opt-in cross-pattern `Alternative` fallback when a
  capability cannot be served (see below), and idempotency — an explicit
  `JobSpec.idempotencyKey`, or a canonical-JSON hash over what work to do
  (pattern id, input, resolved assets, session, step index). Routing metadata
  is deliberately excluded from the hash, and values that cannot be canonically
  serialised are rejected loudly rather than colliding silently.

- **Same-model retry is opt-in and separately bounded
  (`InlineRuntimeInit.transientRetry`).** Atomic dispatch runs two nested,
  independently bounded loops. The outer one is the model fallback walk: a
  candidate the dispatch has given up on goes into `ResolveContext.excludeModel`
  and the next hop resolves someone else, bounded by
  `InlineRuntimeInit.fallbackDepth` (3) or per dispatch by
  `ResolveContext.fallbackDepth`. The inner one calls the SAME model again and
  runs only when a host wires `transientRetry: { isTransient, policy }` — a
  predicate over the error plus a core `RetryPolicy` for the attempt count and
  backoff. Neither budget draws on the other: three retries at one provider
  still cost one fallback hop, and a five-model chain still gets each model the
  same attempt count.

  Without `transientRetry` the behaviour is unchanged from having no retry at
  all — one call per model, then exclusion — because the library ships no
  transience classifier and will not invent one. Media generation calls run for
  tens of seconds and cost real money, so a wrong guess is expensive in both
  directions: a 429 read as fatal drops the dispatch onto a pricier or worse
  candidate, and a content rejection read as a blip pays for the same refusal
  three times. `isTransient` receives the capability, the `provider:modelId`,
  and the 1-based attempt, so one runtime can answer differently for a cheap
  image call and an expensive video one. Backoff honours `ctx.signal`: a cancel
  mid-backoff rejects immediately rather than after the delay elapses.

- **Alternative fallback is opt-in (`InlineRuntimeInit.alternatives`).**
  `'off'` (the default) or `'auto'`. Under `'off'`, a dispatch whose capability
  cannot be served and that has a matching declared alternative fails with a
  structured `ALTERNATIVES_NOT_ENABLED` `JobError` whose `details.diagnostic`
  carries the capability, the unavailability reason, every applicable path
  (`id` / `description` / `targetPatternId`) and a hint for switching redirects
  on — so the host, or an LLM reading the failed tool result, chooses the
  degraded path deliberately instead of receiving it silently. With no
  applicable alternative the failure is the router's own
  `NO_MODEL_FOR_CAPABILITY`, unchanged, and a failed *model call* rethrows the
  provider's error rather than a routing-policy code: there a model was found
  and the auth / input / network failure is the actionable one.

  Off by default because substituting a semantically different path is a product
  decision, not a runtime one — a caller who asked for an identity-preserving
  edit and silently received a re-render from a caption got a different answer,
  not a retry. Under `'auto'` the runtime takes the first alternative whose
  `appliesWhen` matches and announces the swap with `job:alternative-selected`
  (carrying the alternative's `preserves` / `losses`) before the redirect
  dispatches. The switch is per runtime instance, not per job; a host that wants
  degradation on some surfaces only constructs two runtimes.

- **Meta and agent execution.** Meta patterns run their compose function with a
  `ctx` that dispatches sub-steps back through the runtime; agent patterns run a
  tool loop over the catalog. Human-in-the-loop `ctx.askUser` calls await the
  host's injected handler with the job left `running`.

- **Sub-agent tool catalog.** `InlineRuntimeInit.catalogOptions`
  (`BuildCatalogDescriptorsOptions`) is forwarded to `buildCatalogDescriptors`
  when the catalog is assembled, so a host that has replaced the reference
  resolver can correct the slot-defaulting sentence in the `dispatch_pattern`
  description instead of shipping a claim about behaviour it no longer
  implements. The retrieval behind a sub-agent's `find_pattern` call — the
  `PatternSearchIndex` over the registry plus `handleFindPattern` — comes from
  `@orchestral/discovery`, a dependency of this package: core owns the wire
  contract, discovery owns the search, and a host installing
  `@orchestral/runtime` gets both without asking.

- **Diagnostics on failure.** When the router rejects a pinned model
  (`ModelExcludedError`), its structured diagnostic — candidate list, required
  tags, exclusion reason — travels on `JobError.details.diagnostic` instead of
  being dropped, so a host can surface why the pin never matched. Any error
  carrying a `diagnostic` reaches the host the same way, including core's
  `MODEL_SPEC_VERSION_UNSUPPORTED`: the dispatch loop runs
  `assertSupportedModelSpecVersion` on the resolved envelope immediately before
  `call`, outside the retry `try`, so an adapter built for a contract generation
  this build cannot execute fails as the wiring error it is rather than being
  swallowed into `excludeModel` and routed around. The fallback `JobError.code`
  for a dispatch failure that carries no code of its own is
  `DISPATCH_EXECUTE_FAILED`.

- **Sub-step visibility (`job:step`).** Meta dispatch reports each sub-step on
  the parent job's stream as it lands, with the step's produced media attached
  — a pipeline is observable while it runs instead of only when it finishes.
  The emit sits inside the dispatch path, so it describes work that actually
  ran and succeeded; `ctx.compute` stays silent.

- **In-memory sidecar tables are bounded by the runtime, not by host
  discipline.** A job's subscriber set is released once a terminal event has
  been delivered — nothing further can fan out for that id, and the Unsubscribe
  a host already holds stays safe to call. The agent envelope table keeps its
  most recent 64 entries and evicts the oldest rather than growing, so a host
  that never calls `disposeAgentEnvelope` leaks a bounded amount instead of one
  entry per agent dispatch. (`getAgentEnvelope` already documented `undefined`
  as a normal answer.) Job controllers were already released in a `finally`.

- **Node requirement declared.** `engines.node >= 18` — the runtime uses
  `node:crypto` for idempotency hashing. `@orchestral/core` itself has no Node
  dependency and runs in renderer / worker / edge contexts.

### Known limitations

- **No durable queue.** The host's process lifecycle owns each job's lifetime.
  `abandonOrphanedJobs()` is the whole crash story: after a crash, the queued /
  running rows a dead process left behind are marked terminal `stale` (emitting
  `job:stale`) — an in-process runtime has nothing left to re-attach to. A
  parked `ctx.askUser` prompt lives in memory and does not survive a restart
  either.

- **Agent resume is lossy.** An agent job can be resumed from a persisted
  `TranscriptStore`, but the replay is best-effort, not byte-exact: the
  transcript stores the agent-loop step projection (text + tool calls + usage),
  not raw provider messages. Resuming loses `tool_use_id` pairing (so the
  assistant's tool calls are dropped from the replayed history), reasoning
  blocks, and the original interleaving. A resumed agent picks up the gist of
  where it left off, not the exact prior conversation.

- **No throttling and no deadlines.** There is no concurrency limit, no
  per-step timeout and no job TTL. Cancellation is by `AbortSignal`;
  concurrency limits and wall-clock deadlines are the host's to impose.
