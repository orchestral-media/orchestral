# Changelog

## 0.4.0

### Minor Changes

- cc7d6d6: A plan can now take media from its caller, key its own steps, and bound how wide a level runs; a step's failure no longer cancels branches that do not depend on it.
  
  **A plan is a media pattern like any other.** `PlanToMetaOptions.assetNeeds` declares the asset slots a plan takes. The pattern then carries `assetNeeds`, so a host's resolution pass runs for it exactly as for an atomic, and `tool.inputs` gains the derived `references` field, so a caller fills slots by handle in the schema it already knows instead of threading an asset id through as an untyped string. Inside the DAG the slots are addressable through a new production, `$input.assets[slot=<name>]` — the media counterpart of `$input.<field>`. An array slot fans in through a single ref. Two new `PlanProblemCode`s name the two ways it can be wrong: `PLAN_INPUT_ASSET_NOT_ALLOWED` (the plan declares no slots) and `PLAN_INPUT_SLOT_UNKNOWN` (the name is not one of them); modality, cardinality and required-ness are checked against the child slot with the existing codes.
  
  **`StepOptions.idempotencyKey`** lets a step inside a meta key its durable row on a string the caller derives, which `JobSpec.idempotencyKey` has always allowed a host submitting directly. The engine's own derivation hashes `sessionId` on purpose, so reuse that outlives a session could not be expressed by choosing an `identity` mode. `RunPlanOptions.idempotencyKeyFor` is the same seam for a plan's steps, which the interpreter dispatches on the author's behalf. It is a pure derivation — it cannot skip a step, supply an output, or stop the walk — and what it changes is which row the dispatch lands on. The burden of "what is the same work" moves with the key, minus one collision the engine keeps: a key already held by a row for a DIFFERENT pattern is refused with the new `IDEMPOTENCY_KEY_CROSS_PATTERN`, because that row's output was gated against the other pattern's schema and never against this one's. Only a caller-supplied key can reach it — the derivation hashes `patternId`. Within one pattern the old rule stands: a key that omits something the step reads returns a stale-but-valid result, not an error. Within one level, two steps of the same pattern under one key collapse to one row and surface as `PLAN_STEP_IN_FLIGHT`, so a key derived from the input alone is not enough for a fan-out.
  
  **`parallel.limit(tasks, concurrency)`** bounds a fan-out. It takes thunks rather than promises, because a promise is already running by the time it is a value; `parallel` itself is unchanged. `RunPlanOptions.concurrency` (also on `PlanToMetaOptions` and `createPlanMeta`) applies it to a plan's levels. Default unlimited. Turning it on has a cost worth reading before you do: `ctx.step` advances a tree-shared counter at call time, and that counter keys the internals of a nested meta run as one plan step — uncapped, a level's steps are all called synchronously and those inner rows land on the same indices every run; capped, a step starts when an earlier one settles, so that stability is given up. A plan's own steps are unaffected either way.
  
  **`PlanOutputSchema.assets[].modality` now accepts core's whole `AssetKind`** — `document`, `data`, `archive` and `other` in addition to image/audio/video. A plan ending in a document was always writable and failed only at the dispatch exit, as an `OUTPUT_SCHEMA_MISMATCH` naming the plan rather than the step that produced the value. `assetKindField()` is the single source both sides now read; `ASSET_KINDS` backs it internally, with a two-way exhaustiveness lock between the two, and is not exported.
  
  Three behaviour changes, all deliberate:
  
  - **A failing step now invalidates exactly its transitive dependents.** Previously the first rejection rejected its whole dependency level and no later level started, so a failure in one branch cancelled unrelated ones. The plan still fails, with the same error — but steps that do not read anything that failed now run and are banked in the JobStore, which is what makes the documented "the steps that succeeded are not re-run when you resubmit" pay off. Two costs: a failing plan now takes as long as its slowest independent branch rather than failing fast, and when several steps fail the error raised is the first in step-list order rather than whichever provider gave up first (previously non-deterministic).
  - **`PLAN_ASSET_REF_RE` no longer matches `$input.…`**, so the two asset productions are disjoint. Nothing that used to run stops running: a step may not be called `input` (`PLAN_STEP_ID_RESERVED`), so those strings always resolved to nothing — they were merely refused by the walk instead of by the grammar. Step ids that only begin with `input` (`$inputs.assets[0]`, `$input-frames.assets[0]`) are unaffected. If you match the exported regex yourself, `$input.assets[0]` now fails it.
  - **An inner asset binding's `modality` is now narrowed, not cast.** The interpreter used to assert that a producing step's `modality` string was an `AssetKind`; any string flowed through silently and failed later, as the PLAN's own output parse. It now throws `PLAN_ASSET_MODALITY_UNKNOWN` at the site it was read. A plan that used to run can now fail: one whose step names a pattern declaring `modality: z.string()` in its outputs and returning something outside the seven kinds (`'img'`). That is the intended trade — a pattern contradicting its own declared outputs is not a value to launder into a valid-looking kind, and refusing at the read names the ref and the site instead of naming the plan after the money is spent. `details.planStepId` is the CONSUMING step at a step binding, and is absent at an `output.assets` entry, which carries `path`; the producer is on `details.ref` in both cases.
  
  Everything else is additive and every default is unchanged: a plan that declares no `assetNeeds`, passes no `concurrency` and supplies no `idempotencyKeyFor` behaves exactly as before, and the child spec `ctx.step` builds is byte-identical when the new option is absent, so no stored idempotency key moves. `planDagSchema({ inputAssets })` is new alongside the existing `PlanDagSchema`, so the one-shot rendering path can ask for the grammar it can satisfy instead of the grammar plus one unsatisfiable production.

### Patch Changes

- Updated dependencies [cc7d6d6]
  - @orchestral/core@0.4.0

## 0.3.0

### Minor Changes

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

## Unreleased

### Added

- Initial release. The plan feature, previously split across three packages:
  the wire schema and the three `$ref` regexes (from `@orchestral/core`),
  `validatePlan` (from `@orchestral/core`), `planToMeta` / `runPlan` /
  `createPlanMeta` (from `@orchestral/patterns`), and `preflightPlan` /
  `formatPlanPreflight` (from `@orchestral/runtime`).
