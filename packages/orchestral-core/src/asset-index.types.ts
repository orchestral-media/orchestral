// AssetLedger type contract. Pure types, zero runtime, zero SDK.
//
// The `modality` field on the asset context is typed as a standalone AssetKind
// rather than the model-facing Modality (the field name / sqlite column name are
// kept → zero migration). image/audio/video share the same names and values, so
// there's no runtime behavior change. Modality goes back to being a pure model
// I/O concept (capability-model.ts) and is no longer borrowed by the asset side.

/**
 * Asset file kind — a second dimension orthogonal to the model-facing
 * {@link Modality} (a coarse MIME-derived enum). image/audio/video share names
 * and values with Modality (zero migration); document/data/archive/other are
 * file-container categories Modality doesn't have. For now document/data/archive
 * are classification labels only, with no consumer (ready for a future UI facet /
 * direct PDF feeding). other is the fail-open fallback (the host still persists
 * the original mediaType, so no information is lost).
 */
export type AssetKind = 'image' | 'audio' | 'video' | 'document' | 'data' | 'archive' | 'other'

/** Human-readable, context-local asset alias, e.g. `image_2`. */
export type Handle = string

/**
 * Minimal payload the host writes into the store / AssetEvent (2 required + 2 optional).
 */
export interface AssetAnnouncement {
  /** Real id (a host concept; the host defines its format). */
  assetId: string
  modality: AssetKind
  /** If omitted, buildAssetIndex mints one (`image_1`); uploads may pass the filename. */
  handle?: string
  /** Human-readable description / caption to help the LLM disambiguate (plain text). */
  label?: string
}

/**
 * Read-only entry indexed by buildAssetIndex.
 */
export interface AssetLedgerEntry {
  handle: string
  assetId: string
  modality: AssetKind
  label?: string
  /** 1-based ordinal within this context and modality; frozen at mint time. */
  sequence: number
  /** Producing toolCallId (used by latestBatchOfModality); for uploads, a host-synthesized id. */
  batchId?: string
}

/**
 * The host → package contract surface. The package never reads the message stream / store itself.
 */
export type AssetEvent = {
  kind: 'asset'
  annotation: AssetAnnouncement
  /** Monotonic sort key (larger = newer). */
  orderHint: number
  batchId?: string
}

/** Slot-keyed handle references filled by the LLM (the value shape of `input.references`). */
export type AssetReferences = Record<string, string | string[]>

/** Compile-time twin of deriveReferencesSchema: per-slot optional keys from
 * an `as const` assetNeeds list — single → string, array → string|string[].
 * All slots optional (required-ness is the host default rule, §5.7). Two
 * projections of one SSOT; keep in lockstep with derive-references-schema.ts. */
export type DerivedReferences<N extends readonly AssetNeed[]> = {
  [Need in N[number] as Need['slot']]?: Need['cardinality'] extends 'single'
    ? string
    : string | string[]
}

/** An asset requirement an author declares on a Pattern. Single hand-written
 * source: the LLM-facing references schema (typed/strict/describe) is derived
 * from this by deriveReferencesSchema. */
export interface AssetNeed {
  /** Semantic slot name (the parameter name for a media input). The current
   * vocabulary lives in each atomic Pattern's assetNeeds declaration:
   * source / mask / reference / control / startFrame / endFrame /
   * referenceVideo / referenceAudio / voiceClone. Open string — new Patterns may coin new slots. */
  readonly slot: string
  readonly modality: AssetKind
  readonly cardinality: 'single' | 'array'
  readonly required: boolean
  /** Semantic description of the slot (English, LLM-facing). Derived into the
   * describe of references.<slot>, and also into the BM25 index — put retrieval
   * terms like inpaint / IP-Adapter here. */
  readonly description?: string
  /** Array upper bound. Note: per-model limits don't belong here (a pattern-level
   * static field can't express "varies by model"); they live in the host's model
   * metadata (declare-full / filter-down). */
  readonly max?: number
}

/** The successful output of the resolution pass: real assetIds landed in ctx.assets. */
export interface ResolvedAssetRef {
  slot: string
  assetId: string
  modality: AssetKind
  /**
   * Which context-local handle this ref was resolved from (`image_1` / an
   * upload filename). resolveAssetReferences always sets this on exit
   * (entry.handle is always at hand), so the host can translate the parent
   * handle into the label of the child context announcement — otherwise the
   * child agent loses its handle→handle translation table.
   * Optional, because meta's internal-asset channel (pattern-ref.ts) bypasses
   * the handle layer: a meta's self-produced assetId is fed directly to the
   * child step and has no source handle to begin with. That path omits this field.
   */
  handle?: string
}

/** A slice of the current ledger state included in error meta for LLM self-correction. */
export interface HandleSnapshot {
  handle: string
  modality: AssetKind
  label?: string
  sequence: number
  batchId?: string
}

/** Discriminated union of resolution failures (fail-closed). */
export type AssetResolutionError =
  | {
      code: 'HANDLE_NOT_FOUND'
      handle: string
      meta: { available: HandleSnapshot[]; byModality: Record<string, HandleSnapshot[]> }
    }
  | {
      code: 'MODALITY_MISMATCH'
      handle: string
      slot: string
      meta: { expected: AssetKind; actual: AssetKind; sameModalityAvailable: HandleSnapshot[] }
    }
  | {
      code: 'REQUIRED_ASSET_MISSING'
      slot: string
      modality: AssetKind
      meta: { sameModalityAvailable: HandleSnapshot[]; hint: 'upload-or-generate' | 'reference-from-history' }
    }
  | {
      code: 'CARDINALITY_VIOLATION'
      slot: string
      meta: { expected: 'single' | { min?: number /* min? is never produced — only max is validated */; max?: number }; got: number; providedHandles: string[] }
    }
  | {
      code: 'UNKNOWN_SLOT'
      /** The undeclared key the caller put in `references`. */
      slot: string
      meta: { declaredSlots: string[]; available: HandleSnapshot[] }
    }

/** Model-visible asset projection (hard projection): structurally contains no assetId. The element type returned by projectAssetsForModel. */
export interface ModelFacingAsset {
  handle: string
  /** `<configured scheme>//<handle>` writing form — usable directly in prose links and references. */
  uri: string
  modality: AssetKind
  label?: string
}

/** Default-rule query. */
export interface QuerySpec {
  modality: AssetKind
  mode: 'latestOfModality' | 'latestBatchOfModality'
}

/** The product of buildAssetIndex; a pure query interface. */
export interface AssetIndex {
  /** Not found = undefined = resolution failure = anti-forgery boundary. */
  resolve(handle: string): AssetLedgerEntry | undefined
  query(spec: QuerySpec): AssetLedgerEntry[]
  /** Full enumeration / debug / rendering. */
  all(): ReadonlyArray<AssetLedgerEntry>
}
