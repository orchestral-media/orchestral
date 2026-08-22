// AssetStore — per-context registry of indirect asset references. The
// interface is substrate-agnostic: a host might back it with a database, a
// key-value store, or anything else that survives its process. The default
// InMemoryAssetStore uses an in-process Map (dev/test only — dropped when the
// process exits). This mirrors the "interface + default implementation"
// layering of JobStore / TranscriptStore.
import { handleCollisionError, mintHandle, parseMintedHandle } from './asset-index'
import type { AssetKind } from './asset-index.types'

/**
 * Minimal payload the host writes into the store.
 * @alpha
 */
export interface RecordAssetInput {
  assetId: string
  modality: AssetKind
  /** Host-defined origin string, e.g. 'tool-output' | 'upload' | 'workflow' | 'intermediate'. */
  origin: string
  /** When the capability is off, the host passes handle = assetId; when on and omitted, the store mints a handle if referenceable=true. */
  handle?: string
  label?: string
  /** The producing toolCallId, or a synthesized id for an upload. */
  batchId?: string
  /** Whether the model can reference / resolve to this asset. Defaults to true; intermediate products of meta sub-steps are recorded as false. */
  referenceable?: boolean
  /**
   * Generic lifecycle-owner (opaque — the library does not interpret it; same semantics
   * as origin). The host maps it to its own cascade/grouping key (e.g. a
   * session id). For chat, omit it and the host falls back to contextId. For
   * agents, the host passes the owning sessionId so child-context products are
   * cascade-cleaned along with the parent.
   *
   * A durable implementation is expected to persist this alongside the record —
   * it is the key the cascade cleanup runs on. InMemoryAssetStore deliberately
   * drops it (AssetRecord has no owner field, and cleanup is moot for a store
   * that dies with the process).
   */
  owner?: string
}

/**
 * Read-only record after the store persists it.
 * @alpha
 */
export interface AssetRecord {
  contextId: string
  assetId: string
  modality: AssetKind
  origin: string
  /** Empty when referenceable=false and not yet promoted. */
  handle?: string
  /** As above; 1-based per (context, modality). */
  seq?: number
  label?: string
  batchId?: string
  referenceable: boolean
  createdAt: number
}

/**
 * Filter for listContext.
 * @alpha
 */
export interface ListContextFilter {
  /** Only these origins (e.g. the upload announcement channel takes ['upload','workflow']). Omit = no origin restriction. */
  origins?: readonly string[]
  /** Include records with referenceable=false (recovery / UI only). Defaults to false. */
  includeNonReferenceable?: boolean
}

/**
 * Asset-ledger interface. Implemented by the host over whatever storage it
 * already runs; the runtime is storage-agnostic. All methods are async.
 * @alpha
 */
export interface AssetStore {
  record(contextId: string, ann: RecordAssetInput): Promise<AssetRecord>
  listContext(contextId: string, filter?: ListContextFilter): Promise<AssetRecord[]>
}

/**
 * In-process Map implementation. For dev / test only; dropped when the process
 * exits. A host injects its own durable store (e.g. SQLite-backed) as a
 * replacement — both implement the same interface.
 * @alpha
 */
export class InMemoryAssetStore implements AssetStore {
  /** contextId → records (insertion order = oldest-first). */
  private readonly byContext = new Map<string, AssetRecord[]>()
  /** `${contextId}::${assetId}` → record (for idempotent dedup lookups). */
  private readonly byAsset = new Map<string, AssetRecord>()
  /**
   * `${contextId}::${modality}` → high-water mark of the ordinals this context
   * has seen for that modality: every fresh mint, plus every host-supplied
   * replay of one of our own mints (`image_2`). Fresh mints start past it.
   */
  private readonly mintCount = new Map<string, number>()
  /** `${contextId}::${handle}` → the record that owns that handle (the one-handle-one-asset check). */
  private readonly byHandle = new Map<string, AssetRecord>()
  /**
   * Monotonic insertion counter used as `createdAt`. It is an ordering ticket,
   * not a timestamp — the first record in a process gets 0 — which keeps
   * dev/test output deterministic. Consumers may only compare createdAt values
   * for ordering; a durable implementation writes real epoch millis there, and
   * both satisfy the only contract the field carries.
   */
  private tick = 0

  private assetKey(contextId: string, assetId: string): string {
    return `${contextId}::${assetId}`
  }

  private handleKey(contextId: string, handle: string): string {
    return `${contextId}::${handle}`
  }

  /**
   * Mint a seq + handle for a referenceable asset (advances the count). A
   * supplied value wins (capability off / upload filename). Same rules as
   * buildAssetIndex, because a durable host replays this store's records
   * through that function and the two must agree:
   * - a supplied handle that replays one of our own mints for this modality
   *   (`image_2`) pins seq to that ordinal and pulls the counter up to it, so
   *   the next fresh mint lands past it instead of on top of it
   * - any other supplied name (`cat.png`, an assetId) takes the next slot
   * - a supplied handle already bound to a DIFFERENT asset in this context is
   *   HANDLE_COLLISION. Checked before anything is written, so a refused
   *   record leaves the store exactly as it was.
   */
  private mint(
    contextId: string,
    modality: AssetKind,
    assetId: string,
    supplied: string | undefined,
  ): { seq: number; handle: string } {
    const mk = `${contextId}::${modality}`
    const prior = this.mintCount.get(mk) ?? 0
    const replayed = supplied === undefined ? undefined : parseMintedHandle(supplied, modality)
    const seq = replayed ?? prior + 1
    const handle = supplied ?? mintHandle(modality, prior)
    const bound = this.byHandle.get(this.handleKey(contextId, handle))
    if (bound !== undefined && bound.assetId !== assetId) {
      throw handleCollisionError(handle, modality, bound.assetId, assetId)
    }
    this.mintCount.set(mk, Math.max(prior, seq))
    return { seq, handle }
  }

  async record(contextId: string, ann: RecordAssetInput): Promise<AssetRecord> {
    const wantRef = ann.referenceable ?? true
    const ak = this.assetKey(contextId, ann.assetId)
    const existing = this.byAsset.get(ak)

    if (existing) {
      // Idempotent: identity-stable. The only allowed change is referenceable
      // moving monotonically false→true; at the moment of promotion, mint a
      // handle if one doesn't exist yet. Mint BEFORE flipping the flag: a
      // refused mint (HANDLE_COLLISION) must leave the record as it was, not
      // promoted-but-handleless.
      if (wantRef && !existing.referenceable) {
        if (existing.handle === undefined) {
          const { seq, handle } = this.mint(contextId, existing.modality, existing.assetId, ann.handle)
          existing.seq = seq
          existing.handle = handle
          this.byHandle.set(this.handleKey(contextId, handle), existing)
        }
        existing.referenceable = true
      }
      return { ...existing }
    }

    // Minting only happens when referenceable=true. It runs first because it
    // is the only step that can refuse (HANDLE_COLLISION): nothing below is
    // reached — no record, no ordering ticket — for a record the store won't keep.
    const minted = wantRef ? this.mint(contextId, ann.modality, ann.assetId, ann.handle) : undefined
    const rec: AssetRecord = {
      contextId,
      assetId: ann.assetId,
      modality: ann.modality,
      origin: ann.origin,
      referenceable: wantRef,
      createdAt: this.tick++,
      ...(ann.label !== undefined ? { label: ann.label } : {}),
      ...(ann.batchId !== undefined ? { batchId: ann.batchId } : {}),
      ...(minted !== undefined ? { seq: minted.seq, handle: minted.handle } : {}),
    }

    if (minted !== undefined) this.byHandle.set(this.handleKey(contextId, minted.handle), rec)
    this.byAsset.set(ak, rec)
    const arr = this.byContext.get(contextId)
    if (arr) arr.push(rec)
    else this.byContext.set(contextId, [rec])
    return { ...rec }
  }

  async listContext(
    contextId: string,
    filter?: ListContextFilter,
  ): Promise<AssetRecord[]> {
    const arr = this.byContext.get(contextId) ?? []
    let out = filter?.includeNonReferenceable ? arr : arr.filter((r) => r.referenceable)
    if (filter?.origins) {
      const allowed = new Set(filter.origins)
      out = out.filter((r) => allowed.has(r.origin))
    }
    // Defensive copy: external mutation must not affect the store's internals
    // (same convention as buildAssetIndex().all()).
    return out.map((r) => ({ ...r }))
  }
}
