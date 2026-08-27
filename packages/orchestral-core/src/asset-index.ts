// AssetLedger pure-function primitives: mintHandle / buildAssetIndex / resolveAssetReferences / projectAssetsForModel. Zero SDK, zero IO.
import type {
  AssetEvent,
  AssetIndex,
  AssetKind,
  AssetLedgerEntry,
  AssetNeed,
  AssetReferences,
  AssetResolutionError,
  HandleSnapshot,
  ModelFacingAsset,
  QuerySpec,
  ResolvedAssetRef,
} from './asset-index.types'
import { fromAssetUri, toAssetUri } from './asset-uri'

/** Mints a 1-based, per-context, per-kind handle. Pure and replayable. */
export function mintHandle(modality: AssetKind, priorCountOfModality: number): string {
  return `${modality}_${priorCountOfModality + 1}`
}

/**
 * Inverse of mintHandle: the ordinal a host-supplied handle encodes when it is
 * a replay of one of OUR mints for this modality, else undefined. `image_2` on
 * an image event → 2. Anything else — an upload filename (`cat.png`), a host
 * alias (`hero-shot`), another modality's mint on this event (`video_3` on an
 * image), or a shape mintHandle never emits (`image_0`, `image_007`, a suffix
 * past the safe-integer range) — is an opaque name and has no ordinal.
 *
 * Strict on purpose: the only handles allowed to steer a counter are the ones
 * that counter itself produced, so the grammar here must be exactly
 * mintHandle's and nothing wider. Checked against the event's own modality
 * rather than the AssetKind set, so no kind name is spelled out here and a
 * new kind needs no edit.
 *
 * Module-level export for its own unit tests; the ledgers reach this rule
 * through mintNext. Not re-exported from index.ts.
 */
export function parseMintedHandle(handle: string, modality: AssetKind): number | undefined {
  const prefix = `${modality}_`
  if (!handle.startsWith(prefix)) return undefined
  const digits = handle.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(digits)) return undefined
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * The one ledger failure buildAssetIndex / InMemoryAssetStore refuse to paper
 * over: one handle, two assets. Silently keeping either side makes the other
 * asset unreachable through the only name the model knows it by — it still
 * sits in storage, but no reference can ever land on it again, and nothing
 * downstream can tell. That is data loss with no symptom, so it is an error.
 *
 * Thrown, not returned as an AssetResolutionError: this is a host-side ledger
 * corruption (a bad replay, two uploads given one name), not a model-side
 * reference mistake the LLM could self-correct from with a HandleSnapshot.
 * `code` follows the runtime's error-code convention (normaliseError reads
 * `.code` and nothing else); `details` carries the facts a host needs to
 * repair the ledger without regexing the message. Order in `assetIds` is
 * binding order: the asset that held the handle first, then the one refused.
 *
 * Module-level export for its own unit tests; the ledgers reach this rule
 * through mintNext. Not re-exported from index.ts.
 */
export function handleCollisionError(
  handle: string,
  modality: AssetKind,
  first: string,
  second: string,
): Error {
  return Object.assign(
    new Error(
      `HANDLE_COLLISION: handle "${handle}" (${modality}) is already bound to asset "${first}"; refusing to rebind it to "${second}"`,
    ),
    { code: 'HANDLE_COLLISION', details: { handle, modality, assetIds: [first, second] } },
  )
}

/**
 * The handle-minting rule, in one place. Both ledgers call it: buildAssetIndex
 * below (replaying a host's persisted records) and InMemoryAssetStore.record
 * (the live write path). A durable host replays the store's records through
 * the index, so the two cannot be allowed to disagree — and the only way to
 * guarantee that is for there to be one rule, not two that must be kept equal.
 *
 * Three rules, in this order:
 * - a supplied handle that replays one of OUR mints for this modality
 *   (`image_2`) pins `seq` to that ordinal and pulls the count up to it, so the
 *   next fresh mint lands past it instead of on top of it. Advancing by count
 *   alone was the bug: replay `image_2` into an empty ledger, mint once, and
 *   the fresh mint is `image_2` too — the replayed asset vanishes behind it
 *   with no symptom.
 * - any other supplied name (`cat.png`, `hero-shot`, an assetId, another
 *   modality's mint) is opaque and takes the next slot, exactly as an
 *   unannotated event would
 * - a handle already bound to a DIFFERENT asset is HANDLE_COLLISION, thrown
 *   before anything is returned, so a caller that mutates only on success
 *   leaves its store exactly as it was
 *
 * `boundAssetIdOf` is a lookup rather than a value because the handle to look
 * up is what this function computes; passing a value would put half the rule
 * back in both callers. It is still pure — same inputs, same result.
 *
 * `nextCount` is the caller's new high-water mark for this modality; the caller
 * owns where that number lives (a Map keyed by modality, or by context and
 * modality), which is the only thing left that differs between the two.
 *
 * Module-level export for asset-store.ts; not re-exported from index.ts.
 */
export function mintNext(args: {
  priorCount: number
  modality: AssetKind
  assetId: string
  supplied: string | undefined
  /** Current owner of a candidate handle in the caller's ledger, or undefined if free. */
  boundAssetIdOf?: (handle: string) => string | undefined
}): { handle: string; seq: number; nextCount: number } {
  const { priorCount, modality, assetId, supplied } = args
  const replayed = supplied === undefined ? undefined : parseMintedHandle(supplied, modality)
  const seq = replayed ?? priorCount + 1
  const handle = supplied ?? mintHandle(modality, priorCount)
  const bound = args.boundAssetIdOf?.(handle)
  if (bound !== undefined && bound !== assetId) {
    throw handleCollisionError(handle, modality, bound, assetId)
  }
  return { handle, seq, nextCount: Math.max(priorCount, seq) }
}

/**
 * Indexes an AssetEvent[] into an AssetIndex. Pure: same input, same output.
 * - processes in ascending orderHint
 * - per-modality counter → 1-based sequence + default handle minting
 * - if annotation.handle is present, use it (a host-persisted handle). When it
 *   is a replay of one of our own mints for that modality (`image_2` on an
 *   image event) the counter is pulled up to that ordinal — max(counter, 2) —
 *   so later mints skip past it. That is honouring the host's replay, not
 *   guessing. Any other name (`cat.png`, `hero-shot`, `video_3` on an image)
 *   takes the next slot exactly as an unannotated event would.
 * - sequence is the replayed ordinal for such a handle, otherwise the counter
 *   after it advanced — so a handle and its sequence never disagree
 * - same handle, same assetId: an idempotent replay; the larger orderHint wins
 *   and the shadowed entry is dropped
 * - same handle, different assetId: HANDLE_COLLISION, thrown. Never a silent
 *   pick — see handleCollisionError for why.
 */
export function buildAssetIndex(events: ReadonlyArray<AssetEvent>): AssetIndex {
  const sorted = [...events].sort((a, b) => a.orderHint - b.orderHint)
  const counts = new Map<string, number>()
  const ordered: AssetLedgerEntry[] = []
  const byHandle = new Map<string, AssetLedgerEntry>()

  for (const e of sorted) {
    const m = e.annotation.modality
    const prior = counts.get(m) ?? 0
    const { handle, seq, nextCount } = mintNext({
      priorCount: prior,
      modality: m,
      assetId: e.annotation.assetId,
      supplied: e.annotation.handle,
      boundAssetIdOf: (h) => byHandle.get(h)?.assetId,
    })
    counts.set(m, nextCount)
    const entry: AssetLedgerEntry = {
      handle,
      assetId: e.annotation.assetId,
      modality: m,
      sequence: seq,
      ...(e.annotation.label !== undefined ? { label: e.annotation.label } : {}),
      ...(e.batchId !== undefined ? { batchId: e.batchId } : {}),
    }
    byHandle.set(entry.handle, entry) // same asset: later (higher orderHint) wins
    ordered.push(entry)
  }

  // Dedup: drop shadow entries overridden by a later same-handle replay of the
  // same asset, so resolve / all / query share one source of truth (no
  // unreachable ghosts).
  const deduped = ordered.filter((e) => byHandle.get(e.handle) === e)

  return {
    resolve: (handle) => byHandle.get(handle),
    query: (spec) => queryIndex(deduped, spec),
    all: () => deduped.slice(), // defensive .slice() copy so external mutation can't affect index internals
  }
}

// Default-rule query: two cardinality-coupled selection modes. `ordered` is already ascending by orderHint.
function queryIndex(ordered: ReadonlyArray<AssetLedgerEntry>, spec: QuerySpec): AssetLedgerEntry[] {
  const ofModality = ordered.filter((e) => e.modality === spec.modality)
  if (ofModality.length === 0) return []
  const latest = ofModality[ofModality.length - 1]
  if (spec.mode === 'latestOfModality') return [latest]
  // latestBatchOfModality
  if (latest.batchId === undefined) return [latest]
  return ofModality.filter((e) => e.batchId === latest.batchId)
}

function toSnapshot(e: AssetLedgerEntry): HandleSnapshot {
  return {
    handle: e.handle,
    modality: e.modality,
    sequence: e.sequence,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.batchId !== undefined ? { batchId: e.batchId } : {}),
  }
}

/**
 * Resolution pass (pure, no IO, fail-closed).
 * references = slot-keyed `Record<slot, handle | handle[]>` (the host shapes
 * this from inputs.references).
 * Omitting a slot → falls back to the default rule (cardinality-coupled).
 * Any failing need → immediately returns a structured error, no further work.
 *
 * LOAD-BEARING ORDER INVARIANT: within a slot, the output order equals the
 * INPUT handle order (we iterate `handles` as given and never sort). Downstream
 * consumers rely on this positional contract — meta_image-best-of-n's judge
 * labels each image "Reference Image i" / "Generated Image i" by array index, so
 * reordering the resolved refs here would silently misalign every label with its
 * image. Do not sort/dedupe the per-slot handles.
 */
// inputs uses an inline type (not a generic <I>) and references is a slot-keyed
// map (not a flat Handle[]) — multiple slots must be mapped per slot.
export function resolveAssetReferences(
  inputs: { references?: AssetReferences } | null | undefined,
  assetNeeds: ReadonlyArray<AssetNeed>,
  index: AssetIndex,
): { ok: true; assets: ReadonlyArray<ResolvedAssetRef> } | { ok: false; error: AssetResolutionError } {
  const refs = inputs?.references ?? {}
  const all = index.all()
  const snapshots = all.map(toSnapshot)
  const sameModality = (m: string): HandleSnapshot[] => snapshots.filter((s) => s.modality === m)

  // Fail-closed on undeclared slot keys (typo / hallucinated slot). The strict
  // derived schema already rejects these on the chat/agent dispatch path; this
  // is the only guard on the meta sub-step path, which skips schema validation.
  const declaredSlots = assetNeeds.map((n) => n.slot)
  const declared = new Set(declaredSlots)
  for (const key of Object.keys(refs)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_SLOT', slot: key, meta: { declaredSlots, available: snapshots } },
      }
    }
  }

  const resolved: ResolvedAssetRef[] = []

  for (const need of assetNeeds) {
    const raw = refs[need.slot]
    const slotOmitted = raw === undefined
    // Blank entries are dropped after uri-normalization: LLMs routinely fill an
    // optional slot with "" instead of omitting the field, and a blank string
    // is never a mintable handle. Dropping it routes the slot through the
    // explicit-empty branch below (optional → skip, required →
    // REQUIRED_ASSET_MISSING) instead of a meaningless HANDLE_NOT_FOUND "".
    const handles: string[] = slotOmitted
      ? []
      : (Array.isArray(raw) ? raw : [raw]).map(fromAssetUri).filter((h) => h.trim() !== '')

    let entries: AssetLedgerEntry[]
    if (slotOmitted) {
      // The default rule applies only to required slots. For optional slots
      // (mask / reference), omission means "don't want it" — never auto-fill
      // from the latest same-modality asset, or you'd mistake the source for a
      // mask (some image-edit models treat source as mask → "mask not supported").
      if (!need.required) continue
      const def = index.query({
        modality: need.modality,
        mode: need.cardinality === 'single' ? 'latestOfModality' : 'latestBatchOfModality',
      })
      if (def.length === 0) {
        // Must be required here (optional slots already continue'd above).
        return {
          ok: false,
          error: {
            code: 'REQUIRED_ASSET_MISSING',
            slot: need.slot,
            modality: need.modality,
            meta: { sameModalityAvailable: sameModality(need.modality), hint: 'upload-or-generate' },
          },
        }
      }
      entries = def
    } else if (handles.length === 0) {
      // Explicit empty selection: required → fail-closed (no default); optional → explicitly not wanted, skip.
      if (need.required) {
        return {
          ok: false,
          error: {
            code: 'REQUIRED_ASSET_MISSING',
            slot: need.slot,
            modality: need.modality,
            meta: { sameModalityAvailable: sameModality(need.modality), hint: 'reference-from-history' },
          },
        }
      }
      continue
    } else {
      entries = []
      // Preserve input handle order (see the order invariant in the JSDoc): push
      // resolved entries in the exact sequence the caller supplied the handles.
      for (const h of handles) {
        const e = index.resolve(h)
        if (!e) {
          const byModality: Record<string, HandleSnapshot[]> = {}
          for (const s of snapshots) (byModality[s.modality] ??= []).push(s)
          return { ok: false, error: { code: 'HANDLE_NOT_FOUND', handle: h, meta: { available: snapshots, byModality } } }
        }
        if (e.modality !== need.modality) {
          return {
            ok: false,
            error: {
              code: 'MODALITY_MISMATCH',
              handle: h,
              slot: need.slot,
              meta: { expected: need.modality, actual: e.modality, sameModalityAvailable: sameModality(need.modality) },
            },
          }
        }
        entries.push(e)
      }
    }

    // cardinality validation
    if (need.cardinality === 'single' && entries.length > 1) {
      return { ok: false, error: { code: 'CARDINALITY_VIOLATION', slot: need.slot, meta: { expected: 'single', got: entries.length, providedHandles: handles } } }
    }
    if (need.cardinality === 'array' && need.max !== undefined && entries.length > need.max) {
      return { ok: false, error: { code: 'CARDINALITY_VIOLATION', slot: need.slot, meta: { expected: { max: need.max }, got: entries.length, providedHandles: handles } } }
    }

    // handle projection: covers both paths — explicit handle resolution
    // (index.resolve) and required-slot default fill (index.query
    // latestOfModality) — in both cases entry.handle is already minted.
    for (const e of entries) resolved.push({ slot: need.slot, assetId: e.assetId, modality: e.modality, handle: e.handle })
  }

  return { ok: true, assets: resolved }
}

/**
 * Hard projection: maps full entries to their model-visible form — only
 * handle/modality/label are exposed, assetId is physically absent. The host
 * calls this from toModelOutput.
 */
export function projectAssetsForModel(
  assets: ReadonlyArray<AssetLedgerEntry>,
): ReadonlyArray<ModelFacingAsset> {
  return assets.map((a) => ({
    handle: a.handle,
    uri: toAssetUri(a.handle),
    modality: a.modality,
    ...(a.label !== undefined ? { label: a.label } : {}),
  }))
}

/** One produced asset in a media-producing Pattern's output (host-finalized form). */
export interface ModelFacingOutputAsset {
  handle: string
  /** `<configured scheme>//<handle>` writing form — usable directly in prose links and references. */
  uri: string
  modality: AssetKind
  label?: string
  /** Generation provenance: produced by a dispatch (vs. uploaded). Host-injected. */
  origin?: 'generated'
  /**
   * The resolved inputs that produced this asset — handle + role only, *never*
   * assetId. The host constructs this from the dispatch's resolution +
   * provenance. The role vocabulary is defined by `AssetRole` in the host; this
   * boundary deliberately widens it to string to avoid a reverse dependency
   * (the host's AssetRole assigns compatibly). The constructor guarantees handle
   * is non-empty (a producer skips inputs without a handle); not enforced at the
   * type level.
   */
  from?: { handle: string; role: string }[]
}

/**
 * Guard for provenance `from`: keeps only {handle, role} (both strings),
 * dropping entries missing a field and any extra fields (e.g. a stray
 * assetId/url that snuck in). Empty / missing / all-invalid → returns
 * undefined so the caller can omit the field entirely.
 */
function projectFromEntries(
  raw: unknown,
): { handle: string; role: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: { handle: string; role: string }[] = []
  for (const f of raw) {
    if (f === null || typeof f !== 'object') continue
    const r = f as Record<string, unknown>
    if (typeof r.handle !== 'string' || typeof r.role !== 'string') continue
    out.push({ handle: r.handle, role: r.role })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Hard projection (tool-result form). The host's dispatch_pattern
 * `toModelOutput` calls this to map the full output returned by main (whose
 * assets[] elements carry real assetIds) into its model-visible form.
 *
 * - `output.assets[]` → strip assetId (and locating fields like url) from each, keep only handle/modality/label
 * - top-level legacy `assetId` field (if any remains) physically deleted
 * - non-asset outputs (text-gen / asr / image-to-text) have no assets[] → returned as-is
 *
 * Pure, no SDK. Returns a new object, never mutates the input. After projection
 * the structure contains no real assetId, so `JSON.stringify` can't leak one —
 * this is the verifiable assertion point for the no-assetId invariant.
 * DESIGN: project-tool-output-hard-projection
 */
export function projectToolOutputForModel(output: unknown): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return output
  }
  const rec = output as Record<string, unknown>
  const rawAssets = rec.assets
  // Non-asset output: no assets[] array → leave untouched (text-style output passes through as-is).
  if (!Array.isArray(rawAssets)) return output

  const projectedAssets: ModelFacingOutputAsset[] = []
  for (const a of rawAssets) {
    if (a === null || typeof a !== 'object') continue
    const el = a as Record<string, unknown>
    const modality = el.modality
    if (typeof el.handle !== 'string') continue
    // Whitelist: produced assets are only media kinds (image/audio/video).
    // document is excluded by design (PDF is an input; no pattern produces a
    // document). text/embedding are not AssetKinds, and no producer emits
    // text/embedding elements inside assets[] (text-gen / asr / image-to-text
    // have no assets[]), so they're outside the projection set — behavior is equivalent.
    if (modality !== 'image' && modality !== 'audio' && modality !== 'video') {
      continue
    }
    // Provenance passthrough: keep host-set origin/from on the projected
    // element. `from` is re-shaped to {handle, role} ONLY — any other field
    // (e.g. a stray assetId/url on a from-entry) is dropped, so the no-assetId
    // invariant holds even if the host hands us a dirty shape.
    const from = projectFromEntries(el.from)
    projectedAssets.push({
      handle: el.handle,
      uri: toAssetUri(el.handle),
      modality,
      ...(typeof el.label === 'string' ? { label: el.label } : {}),
      ...(el.origin === 'generated' ? { origin: 'generated' as const } : {}),
      ...(from ? { from } : {}),
    })
  }

  // Copy the remaining top-level fields, but physically delete assetId (legacy
  // singular). After finalization, locating fields like url live only inside
  // assets[] elements and no longer appear at the top level, so no extra stripping is needed.
  const { assets: _assets, assetId: _assetId, ...rest } = rec
  void _assets
  void _assetId
  return { ...rest, assets: projectedAssets }
}
