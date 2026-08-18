// AssetStore — per-context registry of indirect asset references (an
// OSS contract, substrate-agnostic). The interface is defined in
// @orchestral/core; the host provides a sqlite implementation
// (SessionAssetStore). The default InMemoryAssetStore uses an in-process Map
// (dev/test only — dropped when the process exits). This mirrors the
// "interface + default implementation" layering of JobStore / TranscriptStore.
import { mintHandle } from './asset-index'
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
 * Asset-ledger interface. Implemented by the host (sqlite / pg / memory);
 * the runtime is storage-agnostic. All methods are async.
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
  /** `${contextId}::${modality}` → count of already-minted (referenceable) records. */
  private readonly mintCount = new Map<string, number>()
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

  /** Mint a seq + handle for a referenceable asset (advances the count). A supplied value wins (capability off / upload filename). */
  private mint(
    contextId: string,
    modality: AssetKind,
    supplied: string | undefined,
  ): { seq: number; handle: string } {
    const mk = `${contextId}::${modality}`
    const prior = this.mintCount.get(mk) ?? 0
    const seq = prior + 1
    const handle = supplied ?? mintHandle(modality, prior)
    this.mintCount.set(mk, seq)
    return { seq, handle }
  }

  async record(contextId: string, ann: RecordAssetInput): Promise<AssetRecord> {
    const wantRef = ann.referenceable ?? true
    const ak = this.assetKey(contextId, ann.assetId)
    const existing = this.byAsset.get(ak)

    if (existing) {
      // Idempotent: identity-stable. The only allowed change is referenceable
      // moving monotonically false→true; at the moment of promotion, mint a
      // handle if one doesn't exist yet.
      if (wantRef && !existing.referenceable) {
        existing.referenceable = true
        if (existing.handle === undefined) {
          const { seq, handle } = this.mint(contextId, existing.modality, ann.handle)
          existing.seq = seq
          existing.handle = handle
        }
      }
      return { ...existing }
    }

    const rec: AssetRecord = {
      contextId,
      assetId: ann.assetId,
      modality: ann.modality,
      origin: ann.origin,
      referenceable: wantRef,
      createdAt: this.tick++,
      ...(ann.label !== undefined ? { label: ann.label } : {}),
      ...(ann.batchId !== undefined ? { batchId: ann.batchId } : {}),
    }
    // Minting only happens when referenceable=true.
    if (wantRef) {
      const { seq, handle } = this.mint(contextId, ann.modality, ann.handle)
      rec.seq = seq
      rec.handle = handle
    }

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
