# Changelog

All notable changes to `@orchestral/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] — Initial public release

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
| `ResolveContext.maxRetries` | One counter for two jobs. A model that fails — even transiently — is added to `excludeModel` for the rest of the dispatch, so it is skipped rather than retried; "retry the same model N times, then fall back" is not expressible. |

There is deliberately no cost or latency metadata on these types: media
generation cost is not reliably computable up front, so anything cost-aware
belongs in your own `getModels` ordering or a custom router. If such a field
ever lands, it lands together with the behaviour that enforces it.

Routing today is therefore ordering plus a small precedence. Candidates are
filtered and ordered by the stored enablement order (`getCapabilityOrder`) or by
the caller's own `ResolveContext.rankedModels`, falling back to the order
`getModels` returned; selection over what survives is pinned model → preferred
provider → tier match (if requested) → first candidate.

There is no per-step timeout and no job TTL. Cancellation is by `AbortSignal`
(`ctx.signal`); wall-clock deadlines are the host's to impose.
