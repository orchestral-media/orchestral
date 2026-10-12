# Changelog

## 0.6.0

### Minor Changes

- f00872f: A Pattern that produces assets takes an optional `input.name`, and the produced asset's handle is that name.
  
  **Why.** Handles were only ever minted, at record time and in completion order. A model that dispatched eleven images in parallel and then wrote `asset://image_4` from its own call order got a real image — the wrong one — and nothing failed. A name bound for the dispatch makes a reference the model did not copy miss with `HANDLE_NOT_FOUND` instead of landing on a neighbour.
  
  **What the model sends.** Registration adds `name` to the tool inputs of every Pattern whose outputs carry `assets[]` — atomics, metas, plans and agents alike — so `dispatch_pattern`, always-load tools, `find_pattern` and the agent loop all carry it. It is trimmed, `asset://hero` reads as `hero`, and a blank name means none. A name in any asset kind's mint grammar (`image_3`, `video_1`) is refused, so a chosen name can neither collide with a minted handle nor be read as a replay that moves the ledger's counter. One product takes the name; several take `<name>-1` … `<name>-n` in output order (`deriveNamedHandles`). A `name` on a Pattern that produces no assets is refused with `INPUT_VALIDATION_FAILED` rather than dropped.
  
  **What the host does.** `resolveAssetReferences` reads the name through the new `productNameOf` and refuses one the context already holds — exactly, or as a `<name>-<n>` — with a new `AssetResolutionError` variant, `HANDLE_TAKEN`, before anything else is evaluated; an exhaustive `switch` over the codes gains a case. `AgentAssetBridge.recordOutput` receives the normalised name, and the agent loop runs `resolveForDispatch` for a named dispatch even when the Pattern declares no asset slots. Just before writing a named call's products, a bridge runs `resolveAssetReferences({ name }, [], index)` again over the context as it stands, minus the assets this call is recording: a same-turn call may have taken the name since, and the store's `HANDLE_COLLISION` would not notice `hero` beside `hero-1`, `hero-2`, while a replay of the call's own products (a retried write, a dedupe hit) keeps the name. On `HANDLE_TAKEN` it records all of that call's products under minted handles and says so in a top-level notice in the tool result, as it does when a write collides. `mintNext`, `parseMintedHandle`, `producesAssets` and `RESERVED_INPUT_KEYS` are exported, so a durable `AssetStore` writes handles by the same rule as `InMemoryAssetStore` and a host can refuse a user-authored schema before saving it.
  
  **Breaking (0.x, no shims).** `references` and `name` are reserved top-level input keys: registration derives both on a copy of the Pattern, and a hand-written top-level `references` or `name` throws `INPUT_RESERVED_KEY` (`details.key` names it, `details.reason` is `'hand-written'`) — delete it, registration derives it. Inputs that are not a `z.object` are judged on their rendered JSON Schema, so the key counts in any member of a union or part of an intersection too. The same code with reason `'undeclared'` is new as well: it refuses a derived field the Pattern's own declaration no longer produces, which happens when a host clears `assetNeeds` on a factory-built Pattern (an override that still declares slots is re-derived instead) or re-registers a registered Pattern whose outputs no longer carry `assets[]`. `extendInputsWithReferences` no longer replaces a hand-written `references`; it throws the same error. A `references` produced by `extendInputsWithReferences`, or placed from `deriveReferencesSchema(...)` unwrapped, is recognised and re-derived from the Pattern's own `assetNeeds`. Nested keys are not reserved. `AGENT_BASE_INPUT_SCHEMA` no longer declares `references`: an agent that declares `assetNeeds` gets the derived field, and one that declares none has none — it was never resolved. `AgentBaseInput`, `agentInputSchema`'s result and `OrchestratorInputSchema` change type with it. `agentInputSchema({ name: … })` throws at construction, as `agentInputSchema({ references: … })` already did, with an `AGENT_INPUT_RESERVED_FIELD` error — a plain `Error` with that message prefix and no `details.key` — not `INPUT_RESERVED_KEY`. An asset-producing Pattern whose tool inputs is not a `z.object` is refused at registration (`EXTEND_NAME_UNSUPPORTED_INPUTS`).
  
  **Prompt caches miss once.** Every asset-producing Pattern's tool schema gains a field, and agent schemas lose their hand-written `references`, so provider-side prompt caches built on the old tool definitions invalidate once.
  
  **Part of the work.** `name` is hashed with the rest of `input`, with no special case: a retry repeats the name and still dedupes, and the same prompt under two names is two products. Nothing is added to `JobSpec`. `meta_plan` reads its DAG without the reserved keys, so a named one-shot plan validates as before. A `references` key sent to `meta_plan`, which declares no slots, used to fail with `PLAN_SCHEMA`; it is now stripped and ignored, like a stray key on any Pattern without slots — except on the agent loop, where a call that also carries a `name` goes through the bridge's resolution pass, which refuses any slot that `references` names with `UNKNOWN_SLOT` before anything is dispatched.
  
  **Plans.** A `name` in a plan step's input is refused with the new `PlanProblemCode` `PLAN_STEP_NAME_NOT_ALLOWED`: a step's products are never recorded under a name, so the plan names its own product instead. A step's `input.references` is unchanged.
  
  **Known limitation.** A hand-written meta's `compose` is not validated, so a `name` it forwards into a sub-step input is never recorded and has no effect.
- 9ca4d97: A `ctx.step` is keyed by where it sits in the dispatch tree, so a step that already succeeded is not paid for again because something beside it ran differently.
  
  **Why.** A step's durable key carried one number from a counter the whole dispatch tree shared, taken when the step was called. When two composes ran at once — parallel nested metas, a capped plan level — or a sibling dedupes on a resubmit and so never runs its compose, the same step drew a different number the next time, missed the row it had written, and ran again. A park (`ctx.askUser`) drew from the same counter, so it moved the key of every step after it.
  
  **What keys a step now.** Its path: the ids of the steps that launched its compose, then its own — `panel-0/meta_image-best-of-n#0/text-to-image#1`. A step named with `stepId` is keyed by that name, so adding, removing or reordering other steps in its compose never re-keys it; it moves only if a step that launched its compose is renumbered, so name that one too. An unnamed step is `${patternId}#${n}` (a `/` in the pattern id is written `%2F`), where `n` counts the unnamed calls to the same pattern earlier in the same compose: inserting a named step, or a call to another pattern, leaves it alone. The path travels as `JobSpec.stepKey`, and `deriveIdempotencyKey` hashes `{ patternId, input, assets, sessionId, stepKey }`, with `stepKey: null` when there is none — a host's direct `submitJob`, an agent loop's tool call. `ctx.askUser` ids keep their `${rootJobId}:ask:` prefix and are counted on their own, so a park moves no step's key. A `retry` on a step whose child is a meta now finds the rows its failed attempt wrote, and the computes it settled; it used to fail with `DUPLICATE_STEP_ID` when the child named its steps, and run every finished step again when it did not. That holds because a meta whose compose fails, or whose output its gate refuses, now settles only once the steps and `ctx.submitJob` children it had already started have settled, and refuses any step, submit or park asked of it after with `STEP_AFTER_COMPOSE_FAILED`, so a failing meta takes as long as its slowest in-flight step — the trade a failing plan already makes for its independent branches. A step still in flight that is itself parked on `ctx.askUser`, inside a nested meta, keeps the failing meta open until that park is answered or the job is cancelled. An adapter that ignores its `AbortSignal` holds a cancelled failing meta open until it returns; deadlines stay the host's to impose. Identical work in one session is one unit of work: two different top-level metas whose first unnamed call to a pattern carries the same input and assets share that row, because `stepKey` separates deliberate repeats inside a compose rather than partitioning a session by meta.
  
  **Every stored key moves once.** Rows written by `ctx.step` now hash a `stepKey` and no `stepIndex`; rows with no `stepKey` lose `stepIndex: 0` and hash `stepKey: null`. The first resubmit after upgrading recomputes what it would have found, once. Nothing stored is lost, a `JobStore` needs no migration, and keys are stable from then on.
  
  **Breaking (0.x, no shims).** `StepOptions.identity` is removed, with `STEP_IDENTITY_REQUIRES_STEP_ID`: a named step is keyed by its name without asking, so delete the option. A caller the compiler does not stop — JavaScript, or options built in a variable — is not refused: the option is ignored, so `identity: 'id'` without a `stepId`, which threw, now dispatches, keyed by position. `StepOptions.metadata` is removed; nothing read it. `JobSpec.stepIndex`, `ExecutionContext.stepIndex` and `DeriveIdempotencyKeyInput.stepIndex` are removed. A default step id in `job:step` and `StepResult.meta.stepId` names a step within its own compose only, so two subtrees can both report `text-to-image#0` — correlate on `childJobId`. An unnamed call to a pattern whose id carries `/` reports its escaped id there: `image-gen%2Ffancy-edit#0`, not `image-gen/fancy-edit#0`. An explicit `stepId` spelled like a default id now collides with the first unnamed call to that pattern in the same compose (`DUPLICATE_STEP_ID`), and one containing `/`, which separates the ids in a step's path, is refused (`STEP_ID_RESERVED_CHARACTER`). So is a `ctx.compute` id containing `/`, whose cache key is built the same way: a root `compute('a/b')` would share a slot with `compute('b')` under a step named `a`. The first `ctx.askUser` in a tree is `…:ask:0` however many steps ran before it.
  
  **Plans.** `RunPlanOptions.concurrency` (and `concurrency` on `PlanToMetaOptions` and `createPlanMeta`) no longer costs a nested meta its rows on a resubmit, and neither does a step the walk skipped as unreachable on one run and ran on the next: a plan names every step, and a nested meta numbers its own.
  
  **Shipped metas.** `meta_script2video` names its three portrait views per character (`portrait-front-<i>`, `portrait-side-<i>`, `portrait-back-<i>`, by the character's position), so they keep their rows whichever character's front portrait finishes first. Every shipped meta that runs steps concurrently is now tested to derive the same keys whichever order its steps settle in.
  
  **What still costs.** Unnamed steps called from concurrent branches of one compose after an `await` — inside capped `parallel.limit` tasks, or `parallel(items.map(async …))` — take their numbers in the order they are reached, which can change between runs, so a resubmit runs them again (never with another step's output: the input is in the key). Name them.

### Patch Changes

- Updated dependencies [f00872f]
- Updated dependencies [9ca4d97]
  - @orchestral/core@0.6.0

## 0.5.0

### Minor Changes

- 073e433: Every AI SDK adapter now refuses a resolved asset slot it does not send to the provider.
  
  **Tightened (0.x, no shims):** `fromVisionModel`, `fromTranscriptionModel` and `fromLanguageModel` fail the call with `ASSET_SLOT_NOT_SUPPORTED` when it carries a resolved slot they do not map, before anything reaches the provider. Until now they ran the call and dropped the slot: a second slot beside image-to-text's or ASR's `source`, or any slot on a `text-generation` call, never reached the model, and nothing in the output said so. `fromImageModel` and `fromSpeechModel` already refused; the rule is now the same across all five. A host that relied on the silent drop removes the reference from the input, or wraps the adapter and sends the slot itself.
  
  Two changes landing alongside this one are internal and change no behaviour: the runtime reads core's `JOB_TERMINAL_STATUSES` instead of its own copy of the terminal set, and `@orchestral/plan`'s two validation layers share one helper for a step's input schema.

### Patch Changes

- Updated dependencies [073e433]
  - @orchestral/core@0.5.0

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
