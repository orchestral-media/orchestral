// Unified ModelCapability metadata — a single conceptual record that unifies
// the previous routing-oriented + persistence-oriented two-schema split.
// Split into two layers:
//
//   • ModelCapabilityRecord — persistable, JSON-safe; what the host writes
//     to its model-catalog store.
//   • ModelCapability       — runtime envelope = record + host-injected
//     `call` adapter; what CapabilityRouter.resolve returns.
//
// This package ships only the shape. Hosts maintain the actual registry
// (CRUD in catalog / Settings UI / SQLite) and inject the `call` adapter
// that bridges to the underlying provider SDK.

import type { Capability } from './capability'
import type { ModelTag } from './model-tag'
import type { Artifact, DispatchResult } from './pattern'
import type { DispatchContext } from './execution-context'

/**
 * Modality channels a model accepts or produces. Drives modality-aware
 * request shaping (vision-LLM gets image parts inlined; text-only LLM gets
 * a clean text path).
 */
export type Modality = 'text' | 'image' | 'audio' | 'video' | 'embedding'

/**
 * JSON Schema Draft-7 / 2020-12 structural type. Stored JSON-safe on
 * `provider_models.capabilities.providerOptions`; hosts convert to whatever
 * validator their Pattern factories use (typically Zod) and feed into
 * `ModelCapability.call` closures + `deriveLlmFacingInputSchema()` lift logic.
 *
 * This package owns the TYPE; the SCHEMA CONTENT (the concrete
 * provider-specific field set, e.g. a camera-control enum) is maintained by the
 * host in catalog data — same pattern as `Pattern.inputs: ZodSchema<unknown>`
 * (interface here, concrete schema in each Pattern file).
 *
 * Loose / structural to avoid a big standard-library dependency. Hosts may
 * use stricter `JsonSchema7` / `JsonSchema202012` types internally.
 */
export interface JsonSchema {
  readonly type?: string | readonly string[]
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly exclusiveMaximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly items?: JsonSchema | readonly JsonSchema[]
  readonly additionalProperties?: boolean | JsonSchema
  readonly oneOf?: readonly JsonSchema[]
  readonly anyOf?: readonly JsonSchema[]
  readonly allOf?: readonly JsonSchema[]
  readonly default?: unknown
  readonly description?: string
  /** Extensible for `x-*` / provider-specific keywords. */
  readonly [k: string]: unknown
}

/**
 * Provenance of capability metadata. Influences router trust + Settings UI
 * presentation.
 *
 * - `provider-default-official` — seeded from a curated catalog tied to a
 *   provider's official model list (we shipped this data, trust it).
 * - `provider-default-compat` — seeded from a compat/proxy provider where
 *   the catalog is a best-effort mapping.
 * - `heuristic` — derived from model-id pattern matching at add-time.
 * - `user` — user-edited in Settings.
 * - `probed` — flipped by a real runtime call confirming / refuting a flag.
 * - `untested` — blank default from a manual model entry not yet probed.
 */
export type CapabilitySource =
  | 'provider-default-official'
  | 'provider-default-compat'
  | 'heuristic'
  | 'user'
  | 'probed'
  | 'untested'

/**
 * Persistable capability blob — the intrinsic schema describing what a model
 * can do. Stored as a JSON blob in the host's model-catalog store.
 * Does NOT carry modelId / provider because those are row-level identifiers
 * in the surrounding table; combine with row identity to get a
 * {@link ModelCapabilityRecord}.
 *
 * `capabilities` is DERIVED from `(inputs, outputs)` via
 * {@link deriveCapabilities} and is denormalised here for fast lookups;
 * the derivation remains the source of truth.
 */
export interface ModelCapabilityBlob {
  /** Capabilities this model can serve (derived from inputs/outputs). */
  capabilities: readonly Capability[]
  /** Routing tags (e.g. 'identity-preserving', 'fast-distilled'). */
  tags?: readonly ModelTag[]

  /** I/O modality channels (drives modality-aware request shaping). */
  inputs: readonly Modality[]
  outputs: readonly Modality[]

  /** Capability flags exposed in Settings UI / dispatcher heuristics. */
  streaming?: boolean
  structuredOutput?: boolean
  toolUse?: boolean
  contextWindow?: number

  /**
   * Routing preference dimension. Read only when the caller passes
   * `ResolveContext.tier`, and best-effort: the first tier match wins,
   * otherwise the resolver falls through to the remaining candidates.
   */
  tier?: 'fast' | 'balanced' | 'premium'

  /** Provenance — influences router trust score. */
  source: CapabilitySource

  deprecated?: boolean

  /**
   * Per-model `providerOptions` schema — the SINGLE SOURCE for field-level
   * capability constraints (lifted to `Pattern.input` by
   * {@link deriveLlmFacingInputSchema}), the UI form data shape (the
   * schema-rendered settings form), AND ai-sdk `providerOptions.{provider}.*`
   * passthrough validation.
   *
   * Stored as `JsonSchema` (JSON-safe → sqlite); host converts to ZodSchema at
   * load time. This package owns the TYPE only; concrete schema content is
   * host data.
   * Example structure for a model that fixes its output count to 2:
   * `{ type: 'object', properties: { n: { const: 2 }, lyrics: { type: 'string' } } }`
   * → derive lifts `n: z.literal(2)` to `Pattern.input.n`; LLM cannot fill `n=3`.
   *
   * A model that omits this field still appears in find_pattern / always-load
   * tool lists, but its inputSchema falls back to the base shape (no
   * providerOptions lift). providerOptions is a per-model progressive
   * enhancement, not a gate on capability visibility; at dispatch the model is
   * simply called with default providerOptions. Shipped models should carry
   * this field where possible so the LLM can drive provider-specific params.
   *
   * Three neighbouring flags are deliberately absent, because each would
   * double-source data this record already carries:
   * - A joint-audio capability flag. `outputs.includes('audio')` plus the
   *   audio-synthesis toggle in the model's own providerOptions already say it,
   *   and that toggle is passed through directly.
   * - Per-modality input flags (`image` / `audio` / `video`). Equivalent to
   *   `inputs.includes(modality)`; consumers read `inputs[]`.
   * - The provider-SDK factory to invoke. That is host-catalog data: the host
   *   picks the entry point when it builds the `call` adapter, so no SDK
   *   vocabulary reaches this record.
   */
  providerOptions?: JsonSchema

  /**
   * How the host resolves this model's `providerOptions` schema at catalog-render
   * time. Host-owned routing of the per-model schema; the library never reads
   * this (it lifts by the LIFT_MARKER symbol only).
   *   'official' → reuse the host's curated schema matched by bare modelId (so a
   *                relay slug like `test2:gpt-image-2` reuses the curated
   *                gpt-image-2 schema). User-confirmed via model settings.
   *   'custom'   → use the user-edited `providerOptions` JsonSchema on this blob.
   *   undefined  → treated as 'official' (default): a curated match lifts, no
   *                match is a no-op. The settings UI surfaces this as a checked,
   *                toggleable box — not a silent guess.
   */
  providerOptionsMode?: 'official' | 'custom'
}

/**
 * Identified record = Blob + (provider, modelId) extracted from the row.
 * What `CapabilityRouter.checkSatisfiable` returns as candidates (the
 * persisted shape, no `call` adapter).
 */
export interface ModelCapabilityRecord extends ModelCapabilityBlob {
  /** Fully-qualified `provider:modelId` (e.g. 'provider:model-id'). */
  modelId: string
  provider: string
  /** Always materialised (defaults to empty array if blob omitted). */
  tags: readonly ModelTag[]
}

/**
 * Runtime envelope — record + host-injected adapter. CapabilityRouter.resolve
 * returns this. The runtime calls `call(effectiveInput, ctx)`; the adapter is
 * responsible for mapping the input + ctx to the underlying provider SDK and
 * returning a DispatchResult-shaped envelope.
 *
 * Primary path only: capability sub-modes are expressed through
 * `input.providerOptions` (typed per-model schema) and `input.references`
 * asset slots.
 *
 * `ctx`: the dispatch context. `ctx.assets` holds the
 * resolution pass output (real assetIds keyed by slot — the LLM only ever
 * filled handles in `input.references`); the adapter reads those real ids
 * and maps them to provider-shaped inputs (fs path / bytes). `ctx.signal`
 * carries the parent job's AbortSignal; `ctx.project` / `ctx.providerOptions`
 * carry host-injected ambient context (validated at the host boundary).
 */
export interface ModelCapability extends ModelCapabilityRecord {
  call<I = unknown, O = unknown>(
    input: I,
    ctx: DispatchContext,
    events?: CallEvents,
  ): Promise<DispatchResult<O>>
}

/**
 * Optional event callbacks the runtime passes into `ModelCapability.call()`.
 * Adapter authors fire these at appropriate points inside their provider
 * SDK calls (e.g., fal-queue progress, runway task update). The runtime
 * fans these out as Job events. Authors who don't have progress info
 * simply don't call the callbacks — events are optional, never required.
 *
 * We model this as discrete callbacks rather than `AsyncIterable<Event>`
 * because:
 *   • Provider SDKs already expose their own progress callbacks
 *     (fal-queue, runway task subscription) — a callback shape adapts to
 *     them in one line. Wrapping each adapter as an async generator is
 *     gratuitous infra.
 *   • Call adapters that have no progress info (most do not) pay
 *     literally zero cost — just don't reference the events object.
 *   • The runtime is the only consumer; we control event fanout shape.
 *     There's no second downstream consumer that benefits from a
 *     standard iteration protocol.
 *   • Backpressure isn't a concern — progress events are coarse
 *     (fal emits a handful per call), and Job event subscribers run
 *     synchronously inside `fanout`.
 */
export interface CallEvents {
  /** Coarse progress hint. fraction is 0..1 (runtime clamps); message is optional. */
  onProgress?(event: { fraction: number; message?: string }): void
  /** Intermediate artifact (low-res preview, draft frame, etc). */
  onArtifact?(artifact: Artifact): void
}

/**
 * Context passed to `CapabilityRouter.resolve`. Drives preference, exclusion,
 * and tier filtering.
 */
export interface ResolveContext {
  tier?: 'fast' | 'balanced' | 'premium'
  preferProvider?: string
  excludeProvider?: readonly string[]
  /**
   * Skip these `provider:modelId` strings when resolving. Populated by the
   * runtime's in-Router retry after a transient failure — the next pass
   * excludes the failed model(s). Empty / unset on first call. This is a
   * `readonly string[]` (multi-model exclude) rather than a single `string`,
   * which supports genuine retry depth.
   */
  excludeModel?: readonly string[]
  /**
   * Host hint: when set, the router treats this exact `provider:modelId` as
   * the only acceptable candidate (workflow node-level pin, picker lock that
   * also constrains model). Behaves like preferProvider + single-model
   * narrowing.
   */
  pinnedModel?: string
  /**
   * Soft, ordered preference list of `provider:modelId` strings — the
   * configured fallback chain for this capability (index 0 = default, rest =
   * fallback order). When present, the router restricts candidates to exactly
   * this set, ordered by it; an empty array means no route. Distinct from the
   * fatal `pinnedModel`: a ranked model that fails is skipped (via the runtime's
   * excludeModel retry) to the next in the list. `pinnedModel` and
   * `rankedModels` are mutually exclusive — a host sets one or the other.
   */
  rankedModels?: readonly string[]
  /**
   * Per-dispatch override for the runtime's fallback-walk depth (how many
   * candidates the excludeModel retry loop will try). The host sets this from
   * `rankedModels.length` so the full configured order is walked rather than
   * being capped by the runtime's default transient-retry budget.
   *
   * Caveat — single counter: the same loop handles transient retry AND the
   * fallback walk. A model that fails (even transiently) is added to
   * `excludeModel` for the remainder of the dispatch, so it is skipped, not
   * retried; "retry the same model N times, then fall back" is not
   * expressible in 0.1.0.
   */
  maxRetries?: number
}
