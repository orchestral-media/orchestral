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

## 0.2.0

## [0.1.0] - 2026-08-25 — Initial public release

First public release. `@orchestral/core` is the substrate-agnostic vocabulary and
contracts at the centre of Orchestral. It ships **no execution engine** and
imports **no provider SDK**: you bring a runtime (`@orchestral/runtime`), a
pattern catalog (`@orchestral/patterns`), and a small `ModelCapability.call`
adapter over whichever provider SDK you use.

### Added

- **The Pattern model.** `Pattern` is a union of three kinds — atomic
  (one capability call), meta (a composed pipeline), and agent (a tool loop).
  Atomic patterns are authored with `defineAtomicPattern(init)`; inputs and
  outputs are zod schemas, so the same definition drives runtime validation and
  the JSON Schema handed to an LLM (`toJsonSchema`).

- **Capability routing and semantic fallback.** `ModelCapability` describes what
  a model can do; `createDefaultCapabilityRouter` resolves a pattern to one.
  When no model can serve a capability, a Pattern's declared `Alternative`s name
  a different Pattern that reaches a degraded but real result, with the
  degradation declared up front (`preserves` / `losses`). Declaring a path does
  not make it fire: whether a runtime redirects through one is the runtime's
  policy, and `@orchestral/runtime` keeps automatic redirects off by default
  (`InlineRuntimeInit.alternatives`), failing with the applicable paths named
  instead. These types describe the paths; they do not promise one is taken.

- **Two separately-bounded failure budgets.** `ResolveContext.fallbackDepth`
  bounds one thing only: how many FURTHER candidates a dispatch may resolve
  after giving up on the model in hand. Calling the *same* model again after a
  blip is a different budget with a different owner — a host opts into it on
  its runtime (`InlineRuntimeInit.transientRetry` in `@orchestral/runtime`) and
  bounds it with a `RetryPolicy`, the same shape `ctx.step` / `ctx.compute`
  already take. Neither budget can spend the other's: retries never cost a
  fallback hop, and a long fallback chain never buys extra attempts at one
  provider. `excludeModel` still carries the models a dispatch has given up on,
  but "given up on" means "out of transient retries", not "failed once".

  Nothing is transient unless the host says so. Media calls run for tens of
  seconds and cost real money, and a wrong guess is expensive in both
  directions — a 429 read as fatal drops the dispatch onto a pricier or worse
  candidate, a content rejection read as a blip pays for the same refusal three
  times — so the library ships no classifier to guess with and defaults to no
  retries at all.

- **Routing visibility (`CapabilityRouter.explain`).** An optional third method
  on the interface — `createDefaultCapabilityRouter` implements it — returning a
  `RoutingExplanation`: every model `getModels` returned, the filter stage that
  dropped each one (`not-enabled` / `not-ranked` / `excluded-provider` /
  `excluded-model` / `tag-mismatch` / `capability-not-declared`), the surviving
  fallback order, and what `resolve` would do with the same arguments (a model
  plus the rule that picked it, `NO_MODEL_FOR_CAPABILITY` with its
  `UnavailabilityReason`, or `MODEL_EXCLUDED` for a pin that is not a
  candidate). `formatRoutingExplanation(explanation)` renders it as plain text
  for a CLI or log; the library still prints nothing itself.

  The default router computes candidates, diagnosis and explanation from ONE
  screening pass, so an explanation cannot disagree with the routing it
  describes. `explain` is optional because a host that implements
  `CapabilityRouter` directly should not have to — feature-detect with
  `router.explain?.(...)`. `tier` appears as a selection rule and never as a
  drop stage, matching the fact that it biases selection without eliminating
  anyone.

- **Adapter-contract versioning.** `ModelCapability.specificationVersion`
  declares which generation of the `call` contract a host adapter implements;
  `MODEL_SPEC_VERSION` is the constant a new adapter references, and
  `SUPPORTED_MODEL_SPEC_VERSIONS` is every generation this build can execute.
  The dispatch path runs `assertSupportedModelSpecVersion(model)` immediately
  before `call`, so an adapter compiled against a newer `@orchestral/core`,
  shipped separately and wired into an older runtime, fails with a structured
  `MODEL_SPEC_VERSION_UNSUPPORTED` (`ModelSpecVersionUnsupportedError`, whose
  `diagnostic` carries the received and supported versions) instead of reaching
  a signature the runtime no longer matches. An envelope that declares nothing
  is read as the pre-versioning generation and dispatches unchanged. The field
  sits on the runtime envelope rather than on `ModelCapabilityRecord`: it
  describes the host code that implements `call`, not the model, so none of it
  is persistable. Hosts driving their own dispatch loop should call the guard at
  the same seam.

- **Streaming intermediate results (`job:step`).** A MetaPattern is one Job to
  its caller — the sub-dispatches it runs have their own ids the caller never
  sees — so a long chain (image → video → speech) used to be silent between
  `job:started` and `job:completed`. `job:step` fires on the parent's stream as
  each step lands, carrying the author-facing `stepId`, the Pattern that ran,
  the sub-dispatch's `childJobId` for correlation, and the media that step
  produced, so an intermediate frame is showable while the rest is still
  running. Exactly once per dispatched step: `ctx.step` rejects a repeated step
  id rather than serving one twice, and a failed step fails the parent.
  `ctx.compute` is silent — it wraps a local function, so there is nothing to
  correlate.

- **Refused agent tool calls (`job:tool-rejected`).** An agent loop can name any
  registered pattern id, and a runtime's recursion guards answer such a call by
  handing the model a structured refusal rather than failing the run — so
  "this agent tried to reach outside its scope" left no trace anywhere the host
  could read: not on the job row (it still settles `done`), not in the transcript,
  not in the agent envelope's tool counter. `job:tool-rejected` is that trace.
  It names the refused target and the agent that asked for it, and discriminates
  on the same `code` the model saw: `SUBAGENT_TOOL_OUT_OF_SCOPE` carries the
  effective allowlist the call was judged against, `CIRCULAR_AGENT_TOOL` the
  ancestor chain it would have closed, `SUBAGENT_BLOCKED` which half of the
  blocklist matched (`AgentToolRejection`). Discriminated rather than one flat
  shape, because each refusal is only judgeable against a different fact.

- **Job lifecycle contracts.** `Job` / `JobStore` / `Runtime`, plus
  `InMemoryJobStore` as the reference store. `JobEvent` covers creation,
  progress, completion, failure, and `job:alternative-selected` — fired once per
  redirect hop with the alternative's id, description, target pattern, and
  declared degradation (`preserves` / `losses`), so a subscriber can say "we
  degraded to X" instead of seeing an indistinguishable completion.
  `Runtime.abandonOrphanedJobs()` is abandonment with bookkeeping on every
  substrate: rows a dead process left `queued` / `running` are marked terminal
  `'stale'` and emitted as `job:stale`, and nothing is resumed. A substrate that
  can genuinely resume lost work exposes that as its own call, so the rows this
  one returns are always safe to read as dead.

- **Registry.** `PatternRegistry` registers patterns, strips authoring-side
  `alternatives` into an attachment table, and warns on suspect output schemas
  (`OUTPUTS_UNBOUNDED_FIELDS`). `resolveNamespace` is the one normalization
  (`namespace ?? inferNamespace(id)`) the registry and a search index share; use
  it rather than `inferNamespace`, which ignores an explicit `pattern.namespace`.
  Patterns whose modality group cannot be inferred land in the `uncategorized`
  namespace instead of a wrong one.

- **Pattern-package convention (`"orchestral"` in package.json) and
  `PatternRegistry.addFromManifest(manifest, module, ops?, options?)`.** A
  package declares `patterns: [{ id, kind, export, requiredOps? }]` so what it
  contributes is readable with `npm view <pkg> orchestral` — no install, no
  execution. `OrchestralManifestSchema` validates the field; `addFromManifest`
  looks each `export` up on the module, calls it with `ops`, verifies the built
  pattern's `id` and `kind` against the declaration, and registers the lot,
  throwing a coded `ManifestError` (`MANIFEST_INVALID` /
  `MANIFEST_UNKNOWN_PATTERN` / `MANIFEST_MISSING_OPS` /
  `MANIFEST_EXPORT_MISSING` / `MANIFEST_EXPORT_NOT_A_FACTORY` /
  `MANIFEST_PATTERN_MISMATCH`) before registering anything when they disagree.
  It returns `{ registered, skipped }` rather than a bare id list, so a partial
  load is legible.

  `requiredOps` is declared per pattern, not per package: of the 19 patterns in
  `@orchestral/patterns` only five declare host operations — four the
  ffmpeg-shaped media ops, `meta_plan` a `getPattern` registry read — and a
  package-wide list would have made those five enough to render the other
  fourteen unloadable for a host with no ffmpeg. `options.only` loads a subset
  by id (an undeclared id is an error, not a no-op) and `options.missingOps`
  chooses between refusing the load (`'throw'`, the default — fail-closed,
  because a pattern quietly missing from the registry resurfaces as a routing
  miss much later) and registering the rest (`'skip'`, which reports every
  omission and why in `skipped`).

  Discovery is a query rather than a registration: npm keyword
  `orchestral-pattern`, GitHub topic of the same name, `orchestral-pattern-*`
  package names. No central index exists. This is a convention plus a loader,
  not a plugin framework — no lifecycle, sandbox, version negotiation or lazy
  activation, and loading a package still runs its code like any import.
  `@orchestral/patterns` and `@orchestral/agent` both carry the field.

- **Tool-surface builders.** `buildCatalogDescriptors` renders registered
  patterns into LLM-facing tool descriptors (`BuildCatalogDescriptorsOptions`
  lets a host that replaced the reference resolver correct the
  omitted-required-slot sentence). `sanitizeToolOutput(output, options)` strips
  inline blobs from tool results, with the detection thresholds
  (`maxInlineLen` / `base64RunMin` / `controlRatio`) callable rather than
  compiled in. `auditOutputsSchema` returns `{ unbounded, notTraversed }` —
  boundedness is proven only when both lists are empty, since an unresolved
  `$ref` or an open object can hide a string of any length.

- **Router tool wire contracts (`FindPatternInputSchema` /
  `DispatchPatternInputSchema`).** The input schemas of the two fixed router
  tools: `buildCatalogDescriptors` serialises them into the tool definitions and
  a host validates an incoming tool call against them, neither of which needs a
  search index. The retrieval that *answers* a validated `find_pattern` call —
  the BM25 index over the registry plus the `handleFindPattern` handler, and the
  diagnostic naming which filter ate the candidates — is provided by
  [`@orchestral/discovery`](https://github.com/orchestral-media/orchestral/tree/main/packages/orchestral-discovery).
  Core is the contract; which retrieval algorithm ranks a catalog is a product
  decision a host may want to replace (embeddings, a hosted search service, a
  hand-written router), and keeping it out is why this package has **no runtime
  dependencies at all**. `@orchestral/runtime` already depends on discovery, so
  a host that drives its agent loop through `InlineRuntime` never installs it by
  hand.

- **Assets.** Asset-ledger primitives plus `toAssetUri` / `isAssetUri` /
  `fromAssetUri` over the neutral default `asset://` scheme, and
  `extendInputsWithReferences` for reference-image slots.

- **Human-in-the-loop wire protocol.** The `ctx.askUser` payloads and answers
  are exported as zod schemas with inferred types (`AskUserConfirmPayload` /
  `AskUserConfirmAnswer`, `AskUserChoicePayload` / `AskUserChoiceAnswer`,
  `AskUserFormPayload` / `AskUserFormAnswer`, `AskUserFormFieldSchema`,
  `AskUserFieldValueSchema`), so a host validates what it receives and what it
  returns against the same definitions the typed facade uses.

- **Shared output shapes.** `dispatchEnvelopeShape` (cost / latencyMs / model /
  provider), `metaEnvelopeShape` (cost / latencyMs), and
  `producedAssetShape(modality)` — composable zod raw shapes patterns spread
  into their output schemas instead of hand-copying the envelope.

- `Capability` covers the media and text capabilities the first-party catalog
  serves, including `embedding`.

- **`cost` on output envelopes is nullable.** `dispatchEnvelopeShape.cost` and
  `metaEnvelopeShape.cost` are `z.number().min(0).nullable()`, so `cost` on
  every atomic and meta output is `number | null`. `null` means "this adapter
  did not report a cost"; `0` means "this call was free". A required,
  non-null shape would leave an adapter that does not know the price with no honest
  value — `undefined` fails the schema and a negative fails `.min(0)` — and
  a twelve-step run that wrote `cost: 0` for every step would come back free
  with the same type and the same confidence as a genuinely free one. `producedAssetShape`'s per-asset `cost` was already
  optional and is unchanged.

- **A diagnostics seam instead of the console.** `DiagnosticsLogger`
  (`warn` / `error`) is where the library sends the few findings it cannot
  express as a `JobEvent`: the registry's authoring lints
  (`OUTPUTS_UNBOUNDED_FIELDS`, `OUTPUTS_UNAUDITED_FIELDS`, and
  `CAPABILITY_NOT_NAMESPACED` — an atomic whose id is neither a first-party
  capability nor `vendor__capability`, because two bare third-party
  `video-concat`s collide in one registry), and a host
  callback (`onJobCreated`, middleware `onError`, a subscriber) that threw.
  `consoleDiagnosticsLogger` is the default; `silentDiagnosticsLogger` is
  for tests and hosts with their own channel. `new PatternRegistry({ logger })`
  routes the lints. Nothing in `@orchestral/core` or `@orchestral/runtime`
  writes to the console directly.

- **`job:model-fallback`.** A `JobEvent` emitted once per fallback hop, at the
  moment a dispatch gives up on a model: `failedModel`, `hop`, `attempts`
  (transient retries against that model plus one), and the `error` that ended
  the last attempt, normalised. It is how a host observes the fallback walk —
  which model was tried, how many times, why it was abandoned — without
  scraping stderr. Not terminal: the job goes on to the next candidate.

- **Plans as data.** A pipeline an LLM (or a host) writes as JSON and the meta
  engine executes. `PlanDagSchema` is the wire schema: steps with `$ref`
  bindings (`$<stepId>.<path>`, `$<stepId>.assets[…]`, `$input.<field>` —
  three regex productions, paths not expressions) and a required `output`
  block; everything a model can fill is bounded. `validatePlan` /
  `assertPlanValid` walk a DAG against a registry lookup and report 28 stable
  `PlanProblemCode`s with zod-style paths; `planRefine` runs the same walk as
  a schema refinement so the one-shot's tool input carries it; a nested
  one-shot step is refused outright (`PLAN_PATTERN_ONE_SHOT`) while a
  persisted plan (`.plan` on the pattern) is an ordinary steppable meta. The
  interpreter ships in `@orchestral/patterns` (`planToMeta` / `meta_plan`);
  routing preflight in `@orchestral/runtime` (`preflightPlan`); the design and
  its refusals in `docs/plan.md`.

- **`PatternBase.origin?: 'plan'` and `MetaPattern.plannedDispatches?`.**
  `origin` records that a pattern was interpreted from a step list —
  provenance a catalog can read, never a permission. `plannedDispatches?(input)`
  lets any meta DECLARE the pattern ids its compose will dispatch, so a
  runtime can hold the declared set to a calling agent's allowlist before
  anything is spent. Every plan declares its static step list; hand-written
  metas may opt in.

- **Name-keyed step identity.** `StepOptions.identity: 'id'` opts a single
  `ctx.step` dispatch out of positional identity: the durable key derives from
  the namespaced step NAME (`JobSpec.stepKey`) instead of the shared step
  counter, so editing a pipeline authored as data re-runs the edited step, not
  everything positioned after it. Requires an explicit `stepId`; positional
  stays the default, and a positional dispatch's key payload is byte-identical
  to pre-`stepKey` rows.

- **`registry.scope()`.** A disposable registration scope for session-lived
  patterns: `scope.add()` registers, `scope.dispose()` unregisters what the
  scope added and nothing else. This is the temporary-plan channel — register
  an interpreted plan for one session, dispose after the job settles. The
  scope does not touch `exposure`: a bare `add` gets the ordinary `'tool'`
  default; it is `planToMeta` that defaults its product to `'no-tool'`, which
  is what keeps a session plan out of other loops' catalogs.

- **`job:tool-rejected` gains `via?`.** When a refusal was judged one level
  down — against a declared inner dispatch of the called meta rather than the
  called id itself — `via` names the declared id that offended, while
  `patternId` stays the call the loop actually made. Absent on direct
  refusals.

### Peer dependencies

- `zod` (`>=4.3 <5`) is a **peer** dependency, not a bundled one. The public API
  is zod-typed, so your app and Orchestral must share a single zod instance — a
  duplicate copy breaks zod's cross-instance checks silently. Install it
  alongside the packages.

### Alpha surface

Marked `@alpha`; may change in a minor release without a deprecation cycle:

- `setAssetUriScheme` — a host overrides the asset-URI scheme once per process,
  keeping every call site parameter-free. Rejects anything that is not a
  well-formed `<scheme>://` prefix, since a bare word would make `isAssetUri`
  match plain handles.
- `deriveReferencesSchema` — a test seam. Production code goes through
  `extendInputsWithReferences`.
- The asset-store surface (`AssetStore` / `InMemoryAssetStore` /
  `RecordAssetInput` / `AssetRecord` / `ListContextFilter`), slash-command
  dispatch (`resolveSlashDispatch` and its result types), per-surface exposure
  resolution (`resolveExposure` / `ResolvedExposure`), `StopConditionDescriptor`,
  and the agent sidecar (`AgentDispatchEnvelope`, `Runtime.getAgentEnvelope?`).
  Each carries the marker in the API report; grep `@alpha` in `etc/core.api.md`
  for the authoritative list.

### Known limitations

Fields that exist on the public types but are not acted on in 0.x — declared for
hosts, planners and UIs, not enforced by this library:

| Field | Status in 0.x |
| --- | --- |
| `ModelCapability.tier` | Read only when the caller passes `ResolveContext.tier`, and then best-effort: first tier match wins, otherwise it falls through. |
| `ModelCapabilityBlob.streaming` / `.structuredOutput` / `.toolUse` / `.contextWindow` / `.deprecated` | Catalog metadata for the host's own Settings UI and dispatch heuristics. Neither the router nor the reference runtime reads them. |
| `cost` / `latencyMs` on output envelopes (`dispatchEnvelopeShape`, `metaEnvelopeShape`) | Carried on every atomic and meta output. Supplied by the host adapter after the call; the library never validates the figure. `cost: null` means the adapter did not report one — it is not 0. |

There is deliberately no cost or latency metadata on the routing types
(`ModelCapability` / `ModelCapabilityBlob`): media generation cost is not
reliably computable up front, so anything cost-aware belongs in your own
`getModels` ordering or a custom router. If such a field ever lands there, it
lands together with the behaviour that enforces it. The `cost` / `latencyMs`
on output envelopes are a different thing: reported by the host after the
call, carried for cost meters and UIs, and never validated — which is why
`cost` is nullable rather than defaulting to 0.

<!-- DESIGN: changelog-no-cost-on-routing-types -->

Routing today is therefore ordering plus a small precedence. Candidates are
filtered and ordered by the stored enablement order (`getCapabilityOrder`) or by
the caller's own `ResolveContext.rankedModels`, falling back to the order
`getModels` returned; selection over what survives is pinned model → preferred
provider → tier match (if requested) → first candidate.

There is no per-step timeout and no job TTL. Cancellation is by `AbortSignal`
(`ctx.signal`); wall-clock deadlines are the host's to impose.

<!-- DESIGN: changelog-no-timeout-no-ttl -->

---

All notable changes to `@orchestral/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.
