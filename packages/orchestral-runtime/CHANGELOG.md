# Changelog

## 0.3.0

### Minor Changes

- ab00fc3: Enforcement now matches the argued design: `buildAlwaysLoadDescriptors` filters
  through `resolveExposure` before reading `exposureMode`; middleware
  short-circuit outputs pass the same exit gate as adapter outputs
  (`OUTPUT_SCHEMA_MISMATCH`), whatever the Pattern's kind — no finish tool ran
  there, so a supplied value answers for itself, and a cache entry the schema now
  rejects fails loudly instead of being served; an agent failure tool-result
  carries `produced_handles` instead of raw asset ids. Single sources reclaimed:
  `toJsonSchema` is the only outbound zod→JSON Schema edge (guarded by a static
  test), handle minting and subagent-blocklist matching are single functions,
  the orchestrator derives its tool list from the patterns package instead of a
  hand copy, and `buildAgentInlineCore` now takes the owner pattern id and fails
  loudly on allowlisted ids missing from the registry (internal signature
  change — it is not on the `@orchestral/runtime` barrel). AI SDK adapters fail
  loudly on unsupported asset slots and no longer lose providerOptions under
  namespaced or relayed provider ids. DESIGN.md citations are now anchors
  verified by a static test.
  
  **The per-Pattern opt-out from the sub-agent blocklist is gone.** The blocklist
  beat `loop.toolPatternIds` at dispatch already; it now beats it at the catalog
  too, so an `agent_` id an author lists is skipped when the inline core is built
  rather than rendered as a tool whose every call comes back `SUBAGENT_BLOCKED`.
  Listing one was never a widening — it was a way to advertise a tool that did
  not work — and the catalog and the call side now say the same sentence.
  Opening recursion means overriding `DEFAULT_SUBAGENT_BLOCKLIST` itself, which
  is the honest place to argue for it: one decision, visible at the seam that
  enforces it, instead of per-Pattern grants that only look like permission.
  
  **New error codes.** `AGENT_TOOL_PATTERN_NOT_REGISTERED` fails an agent
  dispatch whose `loop.toolPatternIds` names ids the registry does not have —
  before the loop starts, since an unsatisfiable allowlist is an authoring error
  and nothing has been dispatched yet to pay for it. `ASSET_SLOT_NOT_SUPPORTED`
  is the loud half of the adapter change above: a slot the adapter cannot send is
  refused by name instead of being dropped on the way to the provider.
  `NO_SOURCE_ASSET` and
  `SOURCE_ASSET_NOT_LOADED` on the `automatic-speech-recognition` path are now
  carried as `code` on the thrown error, not just spelled in its message, so a
  host narrows on them the way it narrows on every other orchestral failure.
  
  **New public exports**, all additive:
  
  - `matchSubagentBlocklist` and the `SubagentBlocklist` type
    (`@orchestral/core`) — the one matcher both the catalog and the call guard
    ask, so a host that wants to predict a refusal asks it too rather than
    re-implementing the prefix rule.
  - `buildAlwaysLoadDescriptors` takes a `surface` option (`@orchestral/core`):
    `'chatTurn'` (default, unchanged) or `'agentLoop'`, so a sub-agent's inline
    core admits an `exposure: 'agent-tool'` Pattern and excludes a chat-only one.
  - `FIRST_PARTY_PATTERN_IDS` (`@orchestral/patterns`) — the shipped id catalog
    as data, grouped by declared kind. This is what ended the orchestrator's hand
    copy; a host registering a subset can read it too.
  - `ORCHESTRATOR_DEFAULT_PROMPTS`, `OrchestratorAgentInit`,
    `OrchestratorPromptOverrides`, and a widened
    `createOrchestratorAgent(init?)` (`@orchestral/agent`) — prompt body, tool
    universe and abort mode are defaults this package picked on your behalf, and
    the alternative to overriding them was forking a package whose entire content
    is one declaration. The no-argument call is unchanged.
  - `AgentAssetBridge.handlesFor` (`@orchestral/runtime`) — optional, so an
    existing bridge still type-checks. Implement it and a failed child dispatch
    reports its partial work as handles the loop can cite; leave it out and the
    loop is told a count, as before.
  
  **`agent_orchestrator` no longer declares `loop.asyncToolPatternIds`.** It has
  one tool universe on purpose. The field prunes the catalog to
  `toolPatternIds ∩ asyncToolPatternIds` and only when `defaultExecutionMode` is
  `'async'`, which this pattern never set — so the declaration bought no
  behaviour and was a second list to keep in sync.
  
  **`image-to-text`: an unknown `mode` no longer throws.** The AI SDK vision
  adapter keeps a copy of the pattern's `mode` enum (it does not depend on
  `@orchestral/patterns`), and a mode with no entry there is now a mode it has no
  default instruction for and nothing more: the call runs with no system text,
  exactly as it does when the caller passes a `prompt`. This is the one place on
  this branch where the change is toward silence rather than away from it, and
  the reason is asymmetry — the failure it removes was "patterns added a word" to
  becoming a hard outage in every host wrapping this adapter, for a mode whose
  only effect is a sentence the caller could have written themselves. A test
  asserts the table still covers the pattern's enum, so the drift shows up in CI
  instead of in production.
  
  **`@orchestral/agent` dropped its `@orchestral/runtime` dependency**, which it
  did not use: the package is a pure declaration and the runtime is where the
  agent seam lives, not where the Pattern is authored. If you were relying on the
  transitive install to get `@orchestral/runtime`, add it to your own
  dependencies — you were always the one constructing the runtime.
- ab00fc3: **Package boundaries.** Four things that were split across packages, or bundled
  into one, moved to where they belong: the plan feature became its own package,
  retrieval became a seam a host injects, core's batteries moved one level down,
  and the job state machine became a function. Breaking — this is 0.x, where a
  minor may break — and every break is one import line or one call site.
  
  ## `@orchestral/plan` — the plan feature is one package
  
  A plan used to be spread over three. The wire schema and `validatePlan` were in
  `@orchestral/core`, `planToMeta` in `@orchestral/patterns`, `preflightPlan` in
  `@orchestral/runtime`. The primitive underneath all three — "read a `$ref` off a
  step's input" — existed three times, with three depth rules and two head filters
  between them, and two of the copies carried a comment asking a human to keep
  them in step. What those comments guarded is the plan's central promise: the
  string layer 1 validates is the string the interpreter substitutes and the
  string preflight bills for. It is one function now, and the promise is a call
  rather than a discipline. Core also sheds its largest file — a 1300-line wire
  format validator that served exactly one Pattern.
  
  - `@orchestral/core` no longer exports `PlanDagSchema`, `PlanStepSchema`,
    `PlanRetrySchema`, `PlanOutputSchema`, `PLAN_VALUE_REF_RE`,
    `PLAN_ASSET_REF_RE`, `PLAN_STEP_ID_RE`, `validatePlan`, `assertPlanValid`,
    `planRefine`, `PlanInvalidError`, or the `PlanDag` / `PlanStep` / `PlanRetry` /
    `PlanOutput` / `PlanProblem` / `PlanProblemCode` / `PlanPatternLookup` /
    `PlanValidateOptions` types. Import them from `@orchestral/plan`; the shapes
    are unchanged.
  - `@orchestral/runtime` no longer exports `preflightPlan`,
    `formatPlanPreflight`, `PlanPreflightDeps`, `PlanPreflightReport`,
    `PlanPreflightStep`, `PlanStepRouting` or `PreflightAlternative`. Import them
    from `@orchestral/plan` and add it to your dependencies. The signatures are
    unchanged — including `deps.resolveCtx`, still the same provider you hand
    `InlineRuntimeInit.resolveCtxProvider`.
  - `@orchestral/patterns` no longer exports `planToMeta`, `runPlan`,
    `PLAN_TOOL_DESCRIPTION`, `PlanMetaPattern`, `PlanToMetaOptions` or
    `RunPlanOptions`. Import them from `@orchestral/plan`. It **keeps**
    `createPlanMeta` and `PLAN_PATTERN_ID`, because this package still ships
    `meta_plan` — its manifest names that factory, and the id is a member of
    `FIRST_PARTY_PATTERN_IDS.meta`. Both are re-exported from `@orchestral/plan`,
    which this package depends on, so you get it transitively.
  
  There is no deprecation cycle on any of these: the old names are gone, not
  aliased, so a stale import fails at build time instead of resolving to a shim.
  
  One behaviour change, unreachable in a valid plan: the interpreter's dependency
  walk used to have no depth limit while the other two capped at 64. All three cap
  at 64 now, and `validatePlan`'s rule 24 already refuses an input nested deeper
  than that, so no plan that validates can tell the difference.
  
  ## Retrieval is a seam, so `find_pattern` is conditional
  
  `@orchestral/runtime` no longer depends on `@orchestral/discovery`. Installing
  the runtime no longer installs a search engine. Retrieval reaches an agent loop
  through `InlineRuntimeInit.patternSearch`, the fourth seam alongside
  `agentRunImpl`, `askUser` and `AgentAssetBridge`.
  
  ```ts
  import { createPatternSearch, QUERY_SYNTAX_HINT } from '@orchestral/discovery'
  
  new InlineRuntime({
    patternSearch: createPatternSearch(registry, { router }),
    catalogOptions: { querySyntaxHint: QUERY_SYNTAX_HINT },
  })
  ```
  
  - **Without the seam, an agent loop gets no `find_pattern` descriptor.** Its
    catalog is the always-load inline core plus `dispatch_pattern` (plus the finish
    tool). A loop whose `loop.toolPatternIds` are all `always-load` is unaffected;
    a loop that was meant to *discover* Patterns loses that ability until the host
    adds the two lines above.
  - **`FindPatternInputSchema.query`'s `describe` no longer carries the query
    mini-language** (`+term`, `select:`, `namespace:`, `<prefix>*`, bare id) or the
    tokenizer guidance. Core names the input contract; it stopped describing one
    index's syntax. This changes the serialised `find_pattern` tool definition —
    the KV-cached prompt prefix — for **every** host, wired or not. Pass
    `@orchestral/discovery`'s `QUERY_SYNTAX_HINT` through the new
    `BuildCatalogDescriptorsOptions.querySyntaxHint` to put the prose back.
  - **New:** `PatternSearch` and `PatternSearchRequest` (types) on
    `@orchestral/core`; `BuildCatalogDescriptorsOptions.includeFindPattern`
    (default `true`) and `.querySyntaxHint`; `ResolveDispatchOptions` and a
    fourth, optional `opts` parameter on `resolveDispatchTarget` (existing
    three-argument calls are unaffected); `createPatternSearch`,
    `CreatePatternSearchOptions` and `QUERY_SYNTAX_HINT` on
    `@orchestral/discovery`; `InlineRuntimeInit.patternSearch`.
  - **Model-visible text changes only when no seam is wired.** `includeFindPattern`
    is one question reaching every string, not just the descriptor list:
    `dispatch_pattern` is still emitted without a seam, but its description and
    its `pattern_id` / `input` `describe`s switch to spellings that name no tool
    the catalog lacks, and `resolveDispatchTarget`'s refusal hints do the same via
    `opts.hasPatternSearch` (the runtime passes it for an unwired agent loop), as
    do two agent-loop hints and the `UNKNOWN_TOOL` message. A wired host gets
    byte-identical strings to before.
  - `PatternBase.searchHint`'s doc comment no longer describes BM25 boost tiers
    (doc only — the field, its type and every consumer are unchanged).
  - **`@orchestral/agent`:** `ORCHESTRATOR_SYSTEM_PROMPT` still tells the model to
    use `find_pattern`, because an orchestrator whose tool universe is the whole
    first-party catalog is meant to be wired. If you deliberately run it without
    retrieval, override the prompt through `prompts.orchestratorSystem` rather than
    shipping a prompt that names a tool the loop lacks.
  
  ## `@orchestral/core/memory` and `@orchestral/core/routing`
  
  **Breaking.** Core ships two subpath entries and the root entry no longer
  re-exports what they own:
  
  | Moved to | Symbols |
  | --- | --- |
  | `@orchestral/core/memory` | `InMemoryJobStore`, `InMemoryAssetStore`, `InMemoryTranscriptStore` |
  | `@orchestral/core/routing` | `createDefaultCapabilityRouter`, `NoModelForCapabilityError`, `ModelExcludedError`, `DefaultCapabilityRouterDeps` |
  
  Nothing moved between packages and no signature changed. The point is that "core
  is the vocabulary" is now a claim an import list can contradict. A deprecated
  alias on the root would have left both spellings resolvable and kept the sentence
  unfalsifiable, so there is none. Migration is one line per import: move the
  symbol out of the `from '@orchestral/core'` list. The contracts these implement —
  `JobStore` / `AssetStore` / `TranscriptStore` / `CapabilityRouter` and their
  companion types — stay on the root entry, because that is what a host writing its
  own implementation reads.
  
  ## One resolver for by-id dispatch
  
  **Breaking.** `resolveSlashDispatch`, `SlashDispatchError` and
  `SlashDispatchResolution` are gone, and with them the `SLASH_PATTERN_NOT_FOUND` /
  `SLASH_NOT_EXPOSED` vocabulary. `resolveDispatchTarget(registry, input, 'slash')`
  was already the same gate — `resolveExposure(...).slash`, fail-closed — and now
  also accepts an unqualified short name, which was the one thing the slash module
  added. Two paths meant two error vocabularies for one refusal.
  
  Migration: replace `resolveSlashDispatch(registry, id)` with
  `resolveDispatchTarget(registry, { pattern_id: id, input }, 'slash')`. It
  validates the input too, and returns the Pattern rather than just its id
  (`target.pattern.id` is the canonical full id). Map `SLASH_PATTERN_NOT_FOUND` →
  `PATTERN_NOT_FOUND` and `SLASH_NOT_EXPOSED` → `PATTERN_NOT_DISPATCHABLE`.
  
  Short-name resolution now applies to **every** audience, not just slash: which
  spelling of an id arrived is orthography, not a surface. `PATTERN_NOT_FOUND`'s
  message says so (`… is not registered (tried full id and short name).`), and its
  `hint` no longer points a person-facing surface at `find_pattern` — a tool the
  person never called.
  
  ## One way into the registry
  
  **Breaking.** `PatternRegistry.add()` is removed; call `register()`. The
  `spec.alternatives` expansion that `add` was named for moved into `register` some
  time ago, leaving two names for one entry point and a class doc still describing a
  layer between them. `registry.add(...)` → `registry.register(...)`, and
  `Parameters<typeof registry.add>[0]` → `Parameters<typeof registry.register>[0]`.
  `PatternScope.add` is unaffected — that one is the scope's own verb, not an alias.
  
  **Breaking.** `PatternRegistry.listForCatalog()` is removed. It was public API
  with no caller in this repo, and it silently returned atomics only — a filter
  neither its name nor its signature mentioned. The replacement is one line that
  shows the filter: `[...registry].filter((p) => p.kind === 'atomic')`. Catalog
  rendering for an LLM was never this method's job (`buildCatalogDescriptors`), and
  neither was retrieval (`PatternSearchIndex` in `@orchestral/discovery`).
  
  `idCarriesKind` had two JSDoc blocks stacked in front of it, of which TypeScript
  read only the second; they are merged.
  
  ## The job state machine is one exported function
  
  `nextJobState(prev, next)` ships on the root entry of `@orchestral/core`, with
  `JobTransition`, `JobLifecycleEventType` and `JOB_TERMINAL_STATUSES`. It answers
  both halves of what a `JobStore` needs to know about a status write: whether the
  move is legal, and which `JobEvent` a legal one produces.
  
  Both halves used to be unwritten. The transition → event map lived in a private
  switch inside `InMemoryJobStore` — a dev-only store — so a durable host store
  re-derived it from a comment. And "a terminal status is terminal" was asserted in
  prose and enforced nowhere: `update()` checked that the status was a legal
  *value*, not that the move was a legal *transition*, so `done → running` wrote
  cleanly and emitted `job:started` after `job:completed`. No subscriber can tell
  that apart from a job genuinely running again, which is what makes it worth a
  function rather than a paragraph.
  
  **`InMemoryJobStore` now refuses an illegal write** — `insert`, `insertIfAbsent`,
  `update` and `conditionalUpdate` all ask `nextJobState` first — and throws a coded
  `JOB_STORE_ILLEGAL_TRANSITION` error carrying `details: { jobId, from, to }`. A
  refusal leaves the row and the subscribers untouched, so a rejected patch cannot
  half-apply. `conditionalUpdate` throws rather than returning `false`: `false`
  means "the row moved on", which a caller retries, and an illegal move is not
  something to retry.
  
  The refused set is exactly two rules. A terminal row (`done` / `error` /
  `cancelled` / `stale`) never changes status again, and nothing moves back to
  `queued`. Everything else is unchanged, including the case worth naming: a
  **same-status patch stays legal on a settled row** and still emits `job:output`.
  Terminal means the status stops moving, not that the row freezes.
  
  No runtime path changes — every write `@orchestral/runtime` makes was already
  legal under this table. `JobStore.update`'s doc comment now states this as a
  conformance requirement, in the same form `insertIfAbsent`'s atomicity
  requirement is stated: **if you maintain a durable store, call `nextJobState`
  from your write paths instead of re-deriving the table.**
  
  ## Also moved, with no change in behaviour
  
  `sumCosts` now lives in `@orchestral/core` beside `metaEnvelopeShape.cost`, whose
  null rule it implements (`@orchestral/patterns` re-exports it, so nothing to do).
  `applicableAlternatives`, `pickAlternative`, `toAvailableAlternative`,
  `readRequiresSemantics` and `AlternativeSelectionDeps` — the registry + router
  pair all four read, which `@orchestral/runtime`'s `RunAlternativeDeps` now
  extends rather than restates — are core's, because deciding whether a declared
  path applies is a read of the registry and the router, while taking one is
  runtime policy — the runtime's `ALTERNATIVES_NOT_ENABLED` diagnostic and a plan's
  preflight now report from the same evaluation instead of two copies of it.
  `ResolveCtxProvider` is core's for the same reason: preflight and
  `InlineRuntimeInit` take the same provider, so it is a contract rather than one
  substrate's detail. `@orchestral/runtime` still re-exports it and
  `AvailableAlternative`, so those two imports are unaffected.

### Patch Changes

- Updated dependencies [ab00fc3]
- Updated dependencies [ab00fc3]
  - @orchestral/core@0.3.0

## 0.2.0

### Patch Changes

- @orchestral/core@0.2.0
  - @orchestral/discovery@0.2.0

## [0.1.0] - 2026-08-25 — Initial public release

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

- **Refused agent tool calls are auditable, and named.** Three guards stand
  between an agent loop and a pattern it may not dispatch — the ancestor cycle
  check, the `loop.toolPatternIds` allowlist, and the default sub-agent
  blocklist — and all three answer with a structured tool-result instead of a
  throw, so one hallucinated pattern id costs a turn rather than the whole run.
  Each now also fans out `job:tool-rejected` on the agent job's stream before
  the refusal reaches the model, carrying the refused target, the calling
  agent, and the reason-specific context (the effective allowlist — the async
  intersection, where one applies; the ancestor chain; which half of the
  blocklist matched). The refusal itself is unchanged: still a tool-result,
  still `done` with `error: null`, still uncounted in the envelope's
  `totalToolUseCount`. Rejections are deliberately kept out of the
  `TranscriptStore` — the only replayable kind is `tool-result`, so recording
  one would change what a resumed model sees.

  Separately, `AGENT_DEPTH_EXCEEDED` — the one guard that does throw — now
  carries its code as an `Error.code`, so it reaches `JobError.code` intact
  instead of normalising to the generic `DISPATCH_EXECUTE_FAILED` and leaving
  hosts to regex the message. The same was true of a dozen other coded throws
  across the package; all of them were fixed, and a source-level test now scans
  `src` for `throw new Error('SOME_CODE: …')` without a matching `.code` so the
  convention fails a test instead of relying on authors remembering it.

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

- **Every output is held to its schema at the dispatch exit
  (`InlineRuntimeInit.outputValidation`).** An atomic or meta output — and any
  output a middleware short-circuits with, whatever the Pattern's kind — is
  checked with `pattern.outputs.safeParse` before the dispatch returns it; one the
  schema rejects fails the job with `OUTPUT_SCHEMA_MISMATCH`, whose `details`
  carries the pattern id and kind, the zod issues (path and message), and
  `rawOutput` — the call was paid for, so a host can still salvage what came
  back. A conforming output is returned as the adapter produced it, unknown
  keys included, never zod's parsed copy: `z.object` strips and defaults, and
  a second reshaping nobody announced would be its own bug. The check sits
  outside the retry and fallback loops, beside the spec-version assert, because
  a mismatch is an adapter-contract violation and not a provider failure — it
  is never put to `isTransient`, and the model is not walked past for a second
  paid output. Under a meta, a sub-step's mismatch surfaces as the
  `META_STEP_FAILED` the meta already reports, with the child's row carrying
  the mismatch itself. The agent path was validating already, through its
  finish tool, and is unchanged on the dispatch path — the short-circuit is the
  one place an agent-kind output meets this gate, because there no finish tool
  ran and the supplied value is making the adapter's claim on its own.

  Strict by default because the schema is the contract everything downstream
  reads against — a parent meta's step result, the model-facing projection, a
  host reading `job.output` — and an adapter that violates it should fail at
  the seam that can name the pattern and the field, not three steps later as an
  `undefined` access. `'off'` skips the check for a migration window over
  adapters the host does not control; there is no warn mode, since a mismatch
  belongs to a job and the runtime does not log what it can fail. Until this
  the bound on every output field was an authoring lint the registry audits at
  registration, and nothing at run time held an adapter to it.

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

- **`submitJob` resolves with a failed Job; it does not reject.** Once a job
  row exists, a dispatch failure is data: the row goes `error` (with `error`
  populated) or `cancelled`, `job:failed` / `job:cancelled` fans out, and the
  promise resolves with that row — the host reads `job.status`, which is
  what `Job` carries `status: 'error'` and `error: JobError` for. The promise
  rejects only when the request never
  became a job — an unregistered `patternId`, an input the idempotency key
  cannot be derived from, a store that refuses the INSERT — because there is
  no Job to return: a request that could not become a job throws; a job that
  ran and failed returns.

- **`InlineRuntimeInit.logger`.** A `DiagnosticsLogger` for the handful of
  diagnostics the runtime cannot express as a `JobEvent` — a host callback
  that threw, a transcript append that failed. Defaults to the console; pass
  `silentDiagnosticsLogger` in tests. The model-call failure that used to be a
  `console.error` on the hot path is now the `job:model-fallback` event.

- **The `plannedDispatches` guard.** When an agent loop dispatches a meta that
  DECLARES its inner dispatch set (`MetaPattern.plannedDispatches` — every
  plan does), each declared id is held to the loop's effective allowlist, the
  default sub-agent blocklist, and the ancestor chain BEFORE the child is
  submitted. The refusal is the direct guard's own shape — same codes, same
  `job:tool-rejected` event — plus `via`, the declared id that offended, so
  the model can tell which of its calls was refused and why. A declaration
  that throws fails open with a logged warning: a buggy `plannedDispatches`
  must not be a denial of service written into a pattern. Undeclared metas are
  unchanged — closing that bypass is a decision about every meta, recorded in
  `DESIGN.md`, not a side effect of plans.

- **A failed child goes back to the loop.** A sub-agent tool dispatch that
  fails now returns a structured `SUBAGENT_TOOL_FAILED` tool result — code,
  child job id, normalised error — instead of tearing down the parent agent,
  so the loop can pick a different pattern or input. Cancellation, agent-depth
  exhaustion and host-wiring failures still rethrow: those are verdicts about
  the parent's run, not about one tool call.

- **`preflightPlan` / `formatPlanPreflight`.** Routes every step of a plan and
  spends nothing: validates the DAG (`validatePlan`), then asks the router for
  each step's atomic capability — served / would-degrade (which declared
  `Alternative` fires, with `preserves` / `losses`) / unavailable — and
  expands a persisted plan-origin meta step one level instead of reporting it
  opaque. `AvailableAlternative` is exported: the same projection the
  `ALTERNATIVES_NOT_ENABLED` diagnostic uses, so preflight and the failure it
  predicts cannot drift apart. `formatPlanPreflight` renders the report for a
  host to put in front of a user before `submitJob`.

- **Name-keyed step identity, engine side.** `deriveIdempotencyKey` accepts
  `stepKey` and folds it in only when present (a conditional spread keeps
  every positional payload byte-identical to pre-`stepKey` rows); the meta
  engine derives it from the namespaced step id when a `ctx.step` passes
  `identity: 'id'`, refuses the opt-in without an explicit `stepId`
  (`STEP_IDENTITY_REQUIRES_STEP_ID`), and keeps the in-run step cache keyed
  apart so the two identity modes cannot alias.

### Known limitations

- **No durable queue.** The host's process lifecycle owns each job's lifetime.
  `abandonOrphanedJobs()` is the whole crash story: after a crash, the queued /
  running rows a dead process left behind are marked terminal `stale` (emitting
  `job:stale`) — an in-process runtime has nothing left to re-attach to. A
  parked `ctx.askUser` prompt lives in memory and does not survive a restart
  either.

<!-- DESIGN: changelog-no-durable-queue -->

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

<!-- DESIGN: changelog-no-throttling-no-deadlines -->

---

All notable changes to `@orchestral/runtime` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.
