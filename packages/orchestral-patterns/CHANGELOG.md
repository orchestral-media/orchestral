# Changelog

## 0.4.0

### Patch Changes

- Updated dependencies [cc7d6d6]
  - @orchestral/core@0.4.0
  - @orchestral/plan@0.4.0

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
  - @orchestral/plan@0.3.0

## 0.2.0

### Minor Changes

- b30b58b: Every meta in the shipped catalog now declares `MetaPattern.plannedDispatches` — the pattern ids its `compose` can dispatch, readable before it runs. The seven hand-written pipelines and the `via-caption` fallback join `meta_plan`, which already declared its step list:
  
  - `meta_script2video` → `text-generation`, `text-to-image`, `image-to-image`, `image-to-video`
  - `meta_storyboard` → `text-generation`, `image-to-image`, `meta_image-best-of-n`
  - `meta_image-best-of-n` → the `innerPatternId` the caller passed (`text-to-image` or `image-to-image`), plus the `image-to-text` judge
  - `meta_ugc-testimonial` → `text-generation`, `text-to-speech`, `text-to-image`, `image-to-video`, `automatic-speech-recognition`
  - `meta_explainer-short` → `text-generation`, `text-to-image`, `text-to-speech`
  - `meta_product-ad-short` → `text-generation`, `text-to-image`, `image-to-video`, `text-to-audio`
  - `meta_product-photo-pack` → `text-generation`, `text-to-image`
  - `meta_image-to-image-via-caption` → `image-to-text`, `text-to-image`
  
  Host ops (`concatVideos`, `addSubtitles`, `stillToVideo`, `addBackgroundAudio`, …) are not dispatches and appear nowhere in these lists. No factory signature or return type changes.
  
  **Minor rather than patch, because an agent host can see new refusals.** `@orchestral/runtime`'s agent guard holds a declaring meta's inner ids to the calling loop's `loop.toolPatternIds` — allowlist, blocklist and ancestor chain — before the child is submitted. A loop that lists a meta but not the patterns it is made of (`meta_script2video` without `text-to-image`, say) now gets `SUBAGENT_TOOL_OUT_OF_SCOPE` up front, with the offending id in `via`, where the same call previously slipped past the guard and ran. What these metas dispatch has not changed; what changed is that they say so in time to be checked. The CHANGELOGs promise "pin `~0.1` for patch-only updates", and a behavioural tightening must not ride a patch.
  
  If an agent of yours dispatches one of these metas, widen its `loop.toolPatternIds` to include the ids above — granting the meta means granting what the meta is made of. Metas dispatched from a host, a chat turn, or another meta's `compose` are unaffected: the check lives on the agent-loop tool-call path and nowhere else.

### Patch Changes

- @orchestral/core@0.2.0

## [0.1.0] - 2026-08-25 — Initial public release

First public release. `@orchestral/patterns` is the first-party Pattern catalog
for Orchestral: atomic capability patterns and composed meta pipelines, with
their prompts inlined and their inputs/outputs zod-typed. It calls no provider
SDK — every model call goes through the `ModelCapability` your host registers.
Agent-kind patterns are not part of this catalog; they ship in the optional
`@orchestral/agent`, which composes this catalog by pattern id.

### Added

- **Ten atomic capability patterns.** `text-to-image`, `image-to-image`,
  `image-to-text`, `text-to-video`, `image-to-video`, `video-to-video`,
  `text-to-speech`, `text-to-audio`, `automatic-speech-recognition`, and
  `text-generation` — one pattern per capability, each a thin typed envelope
  over the resolved model call.

- **Nine meta pipelines.** Four composed deliverables (explainer short,
  product ad short, product photo pack, UGC testimonial) alongside the
  planning and utility pipelines they and your own metas build on
  (storyboard, script-to-video, best-of-N image selection, the
  `via-caption` image-edit fallback — the only `Alternative` target in the
  catalog), and `meta_plan`, the one-shot plan interpreter (see below).

- **The catalog is these nine, on purpose.** The long-form novel → video
  pipeline — `meta_script-planning`, `meta_prose-chunking`,
  `meta_novel-to-events`, `meta_event-to-script`, `meta_idea2video`, and the
  `agent_long-form-video` director that was their only consumer — is not in
  the package. It lives, unchanged and with its tests, in
  `examples/long-form-video`: a host that registers the six from its own
  source next to this catalog. Two more metas (`meta_lyrics-to-mv`,
  `meta_reference-image-cascade`) were dropped outright. The reason is surface
  area: every inlined prompt on a published API is a maintenance liability and
  a PR magnet, and those six were one pipeline with one consumer. What ships is
  what a host composes.

- **Typed pattern functions.** `textGeneration`, `textToImage`, `imageToText`,
  `textToSpeech`, `textToAudio`, `imageToVideo`, `imageToImage`,
  `automaticSpeechRecognition`, `imageBestOfNMeta`, and
  `script2videoMeta` give compile-time-checked meta composition; every
  first-party meta dispatches its sub-patterns through them rather than through
  stringly-typed `ctx.step` refs. `ImageGenerationParams` and
  `AsrTranscriptionParams` are exported as the documented host-read top-level
  param channels for machine-to-machine sub-steps.

- **Prompt overrides.** Every prompt-using meta factory accepts an optional
  `prompts?: Partial<…>` (per-meta `*PromptOverrides` types), resolved once at
  factory time. The shipped defaults are exported per meta as frozen
  `*_DEFAULT_PROMPTS` objects, so you extend the wording instead of forking the
  pattern. Metas that share the storyboard design prompt override it
  independently.

- **Uniform cost envelope.** Every meta output carries `cost` / `latencyMs`
  (aggregated across sub-steps, `null` if any sub-step left its cost
  unreported; wall-clock compose time), so a generic consumer can rely on those
  fields on any dispatch.

- **Uniform `assets[]` + `label` envelope on every media-producing meta.**
  Every meta that produces media returns one flat top-level `assets[]` — the
  same `{ assetId, modality, url?, cost? }` element the atomics produce, plus
  a required `label` naming the role the asset played: `final-video` on every
  pipeline that ends in a video, `music`, `hero`, `voiceover`, `shot-<i>`,
  `scene-<i>-image` / `scene-<i>-vo`, `panel-<i>`, and `winner` / `candidate`
  (best-of-n keeps submission order, so `assets[i]` is still candidate `i`).
  No other output field carries an asset id, nested or not. The reason is the
  model-facing projection: `projectToolOutputForModel` in `@orchestral/core`
  rebuilds `assets[]` from the handle whitelist and deletes the legacy
  top-level `assetId`, but passes every other field through untouched — so a
  `videoAssetId`, or a `panels[].assetIds`, reaches the model as a raw id on
  every dispatch. `label` is on that whitelist, which is why the role rides on
  the element rather than in a field name; a consumer (`meta_storyboard`
  reading `meta_image-best-of-n`'s `winner`) finds an asset by label.
  `meta_storyboard`'s `panels[]` carries only the shot's non-asset fields and
  its images are the `panel-<shotIndex>` elements of `assets[]`;
  `meta_explainer-short`'s `scenes[]` carries only `{ type, narration }` and
  its media is in `assets[]` by scene label.

- **Every string in every outputs schema is bounded.** The registry's
  registration-time lint (`OUTPUTS_UNBOUNDED_FIELDS`) audits each pattern's
  outputs for a bare `z.string()`; the shipped catalog — ten atomics,
  `via-caption`, and the seven metas — now registers with zero warnings, and
  a test (`registry-outputs-bounded.test.ts`) keeps it that way. The bounds
  are generous and fit the field (`text-generation.text` 64 KiB, an ASR
  transcript 256 KiB, a judge rationale 2 KiB, …) and are tabled in one place
  — the README's *Conventions* — so they can be retuned together. Array
  lengths the audit cannot bound (`segments[]`, `panels[]`, `assets[]`) are
  documented on the field.

- **Meta authoring surface.** `MetaCommonDeps` (the host-op contract every
  deliverable meta `Pick`s from), plus `firstAsset`, `firstAssetId`,
  `labelAsset`, `labelledAssetShape`, `assetIdByLabel`, `parseJsonWithSchema`,
  `resolvePrompts`, `styleTag`, `sumCosts`, and `toJsonSchemaCached` — the
  helpers a third-party meta needs to build the same cost envelope,
  produced-assets envelope, and prompt fragments the first-party metas do.
  (`toJsonSchemaCached` is memoised and returns a shared object per schema —
  treat the result as immutable; the `-Cached` suffix keeps it distinct from
  `@orchestral/core`'s uncached `toJsonSchema`.)

- **Cost gates on every multi-generation meta.** The four deliverable metas —
  `meta_explainer-short`, `meta_product-ad-short`, `meta_product-photo-pack`,
  and `meta_ugc-testimonial` — put their paid multi-generation steps behind a
  `ctx.askUser` checkpoint. The two pipeline metas, `meta_script2video` and
  `meta_storyboard`, bound and confirm theirs up front with one vocabulary:
  `maxShots` (default 12) is told to the design model and enforced on its
  answer — a storyboard planned past it is refused with a coded error
  (`SCRIPT2VIDEO_SHOT_CAP_EXCEEDED` / `STORYBOARD_SHOT_CAP_EXCEEDED`) before
  any render, never sliced, since a scene cut at shot N loses its ending —
  and one `ctx.askUser.confirm` in front of the first paid call states the
  exact counts (portraits / frames / clips for script2video; shots / images /
  judge calls for storyboard). A declined gate returns the plan with empty
  `assets` and the planning cost only. `confirmBeforeRender: false` skips the
  confirm for a caller that has already gated, as the long-form example's
  `idea2video` does; on a runtime built without an `askUser` handler the gate
  fails with `ASK_USER_NOT_SUPPORTED` rather than rendering unasked.

- **Ships an `"orchestral"` manifest in package.json** — the pattern-package
  convention core defines (`OrchestralManifestSchema`). It declares all 18
  patterns as `{ id, kind, export }`, and `requiredOps` is declared *per
  pattern*: only four metas name host operations
  (`meta_explainer-short` → `concatVideos` + `stillToVideo`,
  `meta_ugc-testimonial` → four, `meta_product-ad-short` → two,
  `meta_script2video` → `concatVideos`). The other fourteen declare none, so a
  host with no multimedia backend still loads them:
  `registry.addFromManifest(pkg.orchestral, patterns, undefined, { missingOps: 'skip' })`
  registers those fourteen and reports the four it left out. With the ops in
  hand, `registry.addFromManifest(pkg.orchestral, patterns, ops)` takes the lot.
  `npm view @orchestral/patterns orchestral` prints all of it without
  installing; the `orchestral-pattern` npm keyword is there for the same reason.

- **`CREDITS.md`** records the provenance of prompt text derived from
  HKUDS/ViMax (MIT): the affected constants are listed file by file and the MIT
  license text is reproduced in full. The file ships inside the published
  tarball.

- **`sumCosts` takes an array and returns `number | null`.**
  `sumCosts(costs: readonly (number | null | undefined)[])`, called as `sumCosts([a.cost, ...bs.map((b) => b.cost)])`.
  This follows `@orchestral/core` making envelope `cost` nullable: when any
  input is `null` (an adapter that did not report a cost) the total is `null`,
  because a partial sum renders as a confident small number a host would read
  as the real total. `undefined` still counts as 0 and the NaN / Infinity guard
  is unchanged. Every first-party meta's `cost` is accordingly `number | null`.

- **The plan interpreter** (`@alpha`). `planToMeta(dag, opts)` turns a JSON
  step list (`PlanDag`, the wire schema in `@orchestral/core`) into an
  ordinary `MetaPattern`: levels run in dependency order, independent steps in
  parallel, each dispatch keyed by step NAME (`identity: 'id'`) so an edited
  plan re-runs the edited step and its downstream, nothing else. The layer-2
  gate `safeParse`s each step's input against the target's schema and
  dispatches the ORIGINAL object, so a plan step and a hand-written meta step
  with the same input share one idempotency key. `createPlanMeta(ops)` builds
  `meta_plan` (`PLAN_PATTERN_ID`), the shipped one-shot whose tool input IS
  the DAG — validated by `planRefine` in the schema itself, exposed
  `deferred`, reaching the registry only through the `requiredOps:
  ['getPattern']` host channel. The returned pattern declares
  `plannedDispatches`, carries `origin: 'plan'`, and a `planToMeta` product
  additionally carries the frozen DAG as `.plan` (`PlanMetaPattern`) — which
  is how validators and preflight tell a persisted plan (steppable) from the
  one-shot (not nestable). `examples/plan-short-clip` runs the same three-step
  pipeline as `examples/incremental-rerun`, authored as JSON.

### Peer dependencies

- `zod` (`>=4.3 <5`) is a **peer** dependency, not a bundled one. Pattern
  `inputs`/`outputs` are zod schemas on the public API, so your app and
  Orchestral must share a single zod instance — a duplicate copy breaks zod's
  cross-instance checks silently.

### Registration requirements

- `image-to-image` is the only pattern here that ships a default Alternative
  (`via-caption` → `meta_image-to-image-via-caption`). Whether it is ever taken
  is the runtime's call, not this package's: `InlineRuntime`'s
  `alternatives: 'auto' | 'off'` switch **defaults to `'off'`**, so out of the
  box an unservable `image-to-image` fails with the structured
  `ALTERNATIVES_NOT_ENABLED` error that names `meta_image-to-image-via-caption`
  as a path you could dispatch yourself — nothing is redirected, and nothing
  extra has to be registered for that failure to be well-formed.
  **`meta_image-to-image-via-caption` must be registered alongside
  `image-to-image` only if you construct the runtime with
  `alternatives: 'auto'`**; in that mode a missing redirect target fails the job
  with `ALTERNATIVE_PATTERN_NOT_REGISTERED` the first time the fallback fires.
  Pass `alternatives: []` to `createImageToImagePattern` to drop the declaration
  altogether — the failure is then the router's plain `NO_MODEL_FOR_CAPABILITY`,
  with no degraded path offered.

### Known limitations

- **Resubmit does not protect the internals of a nested positional meta.** A
  plan's own steps are keyed by name (`identity: 'id'`) and come back from the
  `JobStore` on resubmit. The INTERNAL steps of a shipped meta called as a
  plan step stay positional on the tree-shared counter, and a plan step that
  dedupes to a cached row skips its compose — and its subtree's counter
  consumption. Resubmitting a partly-failed plan that contains two or more
  such metas can therefore shift the later one's inner indices and re-run
  (re-pay) inner steps that had completed. This is the engine's documented
  cost of positional identity (DESIGN.md, "We don't content-hash step ids"),
  not a plan behavior: the plan neither adds nor removes identity for other
  metas' internals.

- **`via-caption` image editing is lossy by construction.** When a host has
  opted into automatic alternatives and no image-to-image model is available,
  the job redirects to `meta_image-to-image-via-caption`, which captions the
  source and re-renders it from that caption plus the edit instruction: style
  survives, subject identity and composition do not, and an inpaint `mask` is
  ignored because the whole frame is regenerated. The output sets `degraded` to
  literal `true` and echoes the resolution it asked for as `requestedSize`, so
  an adapter that ignores the requested size shows up as a visible discrepancy
  rather than a silent downgrade. Dispatching the meta directly has the same
  properties — the losses are the path's, not the redirect's.

---

All notable changes to `@orchestral/patterns` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.
