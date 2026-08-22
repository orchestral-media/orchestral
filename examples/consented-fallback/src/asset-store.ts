// The host's asset store — the other thing the @orchestral packages leave to
// the host besides `ModelCapability.call`. Orchestral passes media between
// steps as assetIds (`ctx.assets`, `output.assets[]`); what an id points at is
// the host's business, and the packages never read or write bytes. This
// standalone host keeps them in a Map. A real host has a ledger plus disk or
// blob storage behind the same two operations: record a produced asset, read
// one back.

export interface StoredAsset {
  mime: string
  base64: string
}

export class HostAssetStore {
  private readonly byId = new Map<string, StoredAsset>()
  private seq = 0

  /** Seed an asset the host already holds (an upload). Returns the id. */
  put(assetId: string, asset: StoredAsset): string {
    this.byId.set(assetId, asset)
    return assetId
  }

  /** Record a produced asset under a fresh id. */
  record(asset: StoredAsset): string {
    this.seq += 1
    const assetId = `img-${this.seq}`
    this.byId.set(assetId, asset)
    return assetId
  }

  /** Fail-closed: an adapter handed an id this host never stored is a bug. */
  get(assetId: string): StoredAsset {
    const asset = this.byId.get(assetId)
    if (!asset) throw new Error(`ASSET_NOT_FOUND: ${assetId}`)
    return asset
  }

  dataUri(assetId: string): string {
    const { mime, base64 } = this.get(assetId)
    return `data:${mime};base64,${base64}`
  }
}
