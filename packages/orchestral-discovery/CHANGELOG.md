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

## [0.1.0] - 2026-08-25 — Initial public release

### Added

- **The Pattern discovery layer.** Retrieval over a `PatternRegistry`, kept out
  of `@orchestral/core` so the contract package carries no search engine and no
  dependency beyond zod. A host that never puts a `find_pattern` tool in front
  of a model never installs this.

  - `PatternSearchIndex` — BM25 (minisearch) over a `PatternRegistry`,
    indexing tool descriptions, `searchHint`, id tokens and slot vocabulary,
    with a mixed-script tokenizer so CJK queries match CJK catalog text.
    Reads the registry through its public accessors only, so the dependency
    runs one way and core never learns this package exists.
  - `handleFindPattern` — the `find_pattern` tool handler. Selector shortcuts
    (`select:<id>`, `namespace:<ns>`, `<prefix>*`, bare id) short-circuit
    ahead of BM25 and then feed the same post-rank filter loop: modality,
    per-audience exposure, host-only agents, router satisfiability. Returns
    `FindPatternResult` with a `diagnostic` breakdown when nothing survives.
  - `DEFAULT_SEARCH_K` (5) — shared by index and handler so the two cannot
    drift.
  - Types: `PatternSearchFilter`, `SkippedPatternRecord`, `FindPatternResult`,
    `FindPatternMatch`, `FindPatternOutputsSummary`,
    `HandleFindPatternOptions`.

  The `find_pattern` **wire contract** lives in `@orchestral/core` instead:
  `FindPatternInputSchema` / `FindPatternInput` sit next to
  `DispatchPatternInputSchema`, because rendering the fixed tool definition
  (`buildCatalogDescriptors`) and validating an incoming call are contract work
  that must not require a search index. This package owns only the retrieval
  that answers a validated call.

---

All notable changes to `@orchestral/discovery` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.
