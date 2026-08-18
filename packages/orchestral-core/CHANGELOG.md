# Changelog

All notable changes to `@orchestral/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

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
