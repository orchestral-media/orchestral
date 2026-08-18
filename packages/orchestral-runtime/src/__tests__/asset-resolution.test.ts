// resolveAssets seam 单测:验证 buildAssetIndex + resolveAssetReferences 的组合接线。
import { describe, expect, it } from 'vitest'

import type { AssetEvent, AssetNeed } from '@orchestral/core'
import { resolveAssets } from '../asset-resolution'

function ev(assetId: string, modality: AssetEvent['annotation']['modality'], orderHint: number): AssetEvent {
  return { kind: 'asset', orderHint, annotation: { assetId, modality } }
}

const NEED_SRC: AssetNeed = { slot: 'source', modality: 'image', cardinality: 'single', required: true }

describe('resolveAssets', () => {
  it('resolves a handle from events into a real assetId', () => {
    const events = [ev('cat1', 'image', 1), ev('cat2', 'image', 2)]
    const r = resolveAssets({ references: { source: 'image_2' } }, [NEED_SRC], events)
    // resolved ref 回带它解析自的 handle(父→子翻译表的源头)。
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }] })
  })

  it('omitted reference → default rule (latest of modality)', () => {
    const events = [ev('cat1', 'image', 1), ev('cat2', 'image', 2)]
    const r = resolveAssets({}, [NEED_SRC], events)
    expect(r.ok && r.assets.map((a) => a.assetId)).toEqual(['cat2'])
  })

  it('unknown handle → structured HANDLE_NOT_FOUND error (fail-closed)', () => {
    const events = [ev('cat1', 'image', 1)]
    const r = resolveAssets({ references: { source: 'image_99' } }, [NEED_SRC], events)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('HANDLE_NOT_FOUND')
    else throw new Error('expected error')
  })

  it('required slot + empty events → REQUIRED_ASSET_MISSING', () => {
    const r = resolveAssets({}, [NEED_SRC], [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('REQUIRED_ASSET_MISSING')
    else throw new Error('expected error')
  })

  it('image 槽填 video handle → MODALITY_MISMATCH', () => {
    const events = [ev('cat1', 'image', 1), ev('v1', 'video', 2)]
    const r = resolveAssets({ references: { source: 'video_1' } }, [NEED_SRC], events)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('MODALITY_MISMATCH')
    else throw new Error('expected error')
  })

  it('single 槽给多个 handle → CARDINALITY_VIOLATION', () => {
    const events = [ev('cat1', 'image', 1), ev('cat2', 'image', 2)]
    const r = resolveAssets({ references: { source: ['image_1', 'image_2'] } }, [NEED_SRC], events)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('CARDINALITY_VIOLATION')
    else throw new Error('expected error')
  })
})
