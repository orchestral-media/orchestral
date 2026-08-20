# Changelog

All notable changes to `@orchestral/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [Unreleased]

### Breaking (0.x)

- **`Runtime.reconcile()` is now `Runtime.abandonOrphanedJobs()`.** Same
  signature, same behaviour — the old name lied. "Reconcile" reads, in a
  distributed-systems context, as *converge to the desired state*, so callers
  assumed a crashed job would be picked back up. It never was: the call finds
  job rows left `queued` / `running` with no live controller and marks them
  terminal `'stale'`, emitting `job:stale`. Nothing is resumed.

  ```diff
  - const stale = await runtime.reconcile()
  + const stale = await runtime.abandonOrphanedJobs()
  ```

  The interface doc no longer hedges that a durable substrate "may re-attach
  and resume" behind this method: a substrate that can genuinely resume lost
  work should expose that as its own call, so the rows this one returns are
  always safe to read as dead.

- **The discovery layer moved out to `@orchestral/discovery`.** `PatternSearchIndex`,
  `handleFindPattern` and their types (`PatternSearchFilter`,
  `SkippedPatternRecord`, `FindPatternResult`, `FindPatternMatch`,
  `FindPatternOutputsSummary`, `HandleFindPatternOptions`) are no longer
  exported from this package. Add `@orchestral/discovery` and import them from
  there — the code is unchanged, so the fix is the import line:

  ```diff
  - import { PatternSearchIndex, handleFindPattern } from '@orchestral/core'
  + import { PatternSearchIndex, handleFindPattern } from '@orchestral/discovery'
  ```

  `@orchestral/runtime` already depends on the new package, so a host that
  drives its agent loop through `InlineRuntime` needs no change.

  Core is the contract; which retrieval algorithm ranks a catalog is a product
  decision a host may want to replace (embeddings, a hosted search service, a
  hand-written router), and it dragged a search dependency into a package that
  otherwise has none. **`minisearch` is no longer a dependency of
  `@orchestral/core`.**

  **What deliberately stayed:** `FindPatternInputSchema` / `FindPatternInput`
  are still exported here, alongside `DispatchPatternInputSchema`. They are the
  find_pattern *wire contract* — `buildCatalogDescriptors` serialises the
  schema into the fixed tool definition and a host validates an incoming tool
  call against it, neither of which needs a search index. `buildCatalogDescriptors`
  and `buildAlwaysLoadDescriptors` also stay: catalog rendering is contract
  work, and `AgentToolDescriptor` is the shape `buildFinishDescriptor` returns.

### Added

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

  `requiredOps` is declared per pattern, not per package: of the 25 patterns in
  `@orchestral/patterns` only six need the ffmpeg-shaped host operations, and a
  package-wide list would have made those six enough to render the other
  nineteen unloadable for a host with no ffmpeg. `options.only` loads a subset
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

### Breaking (0.x)

- **Removed all declaration-only metadata.** These fields and types were
  documented as "declared but not implemented" — nothing in the library read
  them, so they promised behaviour that never existed:
  - `ModelCapability.cost` / `.latencyMs` / `.maxConcurrency` (media
    generation cost is not reliably computable up front; cost-aware routing
    belongs in the host's `getModels` ordering or a custom router).
  - `Alternative.costMultiplier` / `.qualityDelta`, and the `qualityDelta`
    field on the `job:alternative-selected` event.
  - The `'budget-below'` arm of `AlternativeAppliesWhen` and its builder
    `whenBudgetBelow` (there was never a budget source to evaluate it).
  - The `BudgetGuard`, `Tracer`, and `Span` interfaces, and the
    `ExecutionContext.budget` / `.tracer` fields (both `@alpha`,
    never called by the library).

  `ModelCapability.tier` stays: the router genuinely reads it when
  `ResolveContext.tier` is passed. If a removed field returns, it will land
  together with the behaviour that enforces it.

## [0.1.0] - 2026-08-16 — Initial public release

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
  When no model can serve a capability, a Pattern's declared `Alternative`s
  redirect the job to a different Pattern that reaches a degraded but real
  result, with the degradation declared up front (`preserves` / `losses` /
  `qualityDelta`).

- **Job lifecycle contracts.** `Job` / `JobStore` / `Runtime`, plus
  `InMemoryJobStore` as the reference store. `JobEvent` covers creation,
  progress, completion, failure, and `job:alternative-selected` — fired once per
  redirect hop with the alternative's id, description, target pattern, and
  declared degradation, so a subscriber can say "we degraded to X" instead of
  seeing an indistinguishable completion.

- **Registry and discovery.** `PatternRegistry` registers patterns, strips
  authoring-side `alternatives` into an attachment table, and warns on suspect
  output schemas. `PatternSearchIndex.search(query, filters, k)` backs a
  `find_pattern` tool; `FindPatternResult.diagnostic.droppedBy` reports which
  filter ate the candidates (including `modality`) — the most actionable thing
  to tell an LLM staring at an empty result list. `resolveNamespace` is the one
  normalization (`namespace ?? inferNamespace(id)`) the registry and index
  share; use it rather than `inferNamespace`, which ignores an explicit
  `pattern.namespace`. Patterns whose modality group cannot be inferred land in
  the `uncategorized` namespace instead of a wrong one.

- **Tool-surface builders.** `buildCatalogDescriptors` renders registered
  patterns into LLM-facing tool descriptors (`BuildCatalogDescriptorsOptions`
  lets a host that replaced the reference resolver correct the
  omitted-required-slot sentence). `sanitizeToolOutput(output, options)` strips
  inline blobs from tool results, with the detection thresholds
  (`maxInlineLen` / `base64RunMin` / `controlRatio`) callable rather than
  compiled in. `auditOutputsSchema` returns `{ unbounded, notTraversed }` —
  boundedness is proven only when both lists are empty, since an unresolved
  `$ref` or an open object can hide a string of any length.

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

### Known limitations

Fields that exist on the public types but are not acted on in 0.x — declared for
planners and UIs, not enforced by this library:

| Field | Status in 0.x |
| --- | --- |
| `ModelCapability.cost` / `.latencyMs` | Never read. The default router does not rank by cost or latency. |
| `ModelCapability.tier` | Read only when the caller passes `ResolveContext.tier`, and then best-effort: first tier match wins, otherwise it falls through. |
| `ModelCapability.maxConcurrency` | Never enforced — neither the router nor `InlineRuntime` throttles. Your dispatch layer must apply the limit. |
| `Alternative.costMultiplier` / `.qualityDelta` | Planner / UI metadata only; they do not reorder alternatives. |
| `appliesWhen: whenBudgetBelow(...)` | Never matches. No budget source is wired in, so this arm always evaluates false. |

With none of these in play, the default router's ranking is: pinned model →
preferred provider → tier match (if requested) → first candidate in declared
order. Ordering what `getModels` returns is how you control routing today.

There is no per-step timeout and no job TTL. Cancellation is by `AbortSignal`
(`ctx.signal`); wall-clock deadlines are the host's to impose.
