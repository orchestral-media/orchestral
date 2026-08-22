// AssetLedger primitive unit tests (mintHandle / buildAssetIndex / query / resolveAssetReferences / projectAssetsForModel).
import { describe, expect, it } from 'vitest'

import { buildAssetIndex, mintHandle, parseMintedHandle, projectAssetsForModel, projectToolOutputForModel, resolveAssetReferences } from '../asset-index'
import type { AssetEvent, AssetLedgerEntry, AssetNeed } from '../asset-index.types'
import { setAssetUriScheme } from '../asset-uri'

describe('mintHandle', () => {
  it('1-based per modality: priorCount 0 -> _1', () => {
    expect(mintHandle('image', 0)).toBe('image_1')
    expect(mintHandle('video', 2)).toBe('video_3')
  })

  it('deterministic: same args -> same handle', () => {
    expect(mintHandle('audio', 5)).toBe(mintHandle('audio', 5))
  })
})

describe('parseMintedHandle', () => {
  it('is the exact inverse of mintHandle for its own modality', () => {
    expect(parseMintedHandle(mintHandle('image', 1), 'image')).toBe(2)
    expect(parseMintedHandle('video_10', 'video')).toBe(10)
  })

  it("a mint for another modality is not this modality's ordinal", () => {
    expect(parseMintedHandle('video_3', 'image')).toBeUndefined()
  })

  it('anything mintHandle never emits is an opaque host name', () => {
    for (const h of ['cat.png', 'hero-shot', 'image_', 'image_0', 'image_007', 'image_1x', 'image_-1', 'image_1_2', 'IMAGE_1']) {
      expect(parseMintedHandle(h, 'image'), h).toBeUndefined()
    }
  })
})

function ev(
  assetId: string,
  modality: AssetEvent['annotation']['modality'],
  orderHint: number,
  extra: Partial<AssetEvent['annotation']> & { batchId?: string } = {},
): AssetEvent {
  const { batchId, ...ann } = extra
  return { kind: 'asset', orderHint, ...(batchId ? { batchId } : {}), annotation: { assetId, modality, ...ann } }
}

describe('buildAssetIndex', () => {
  it('mints per-modality 1-based handles in orderHint order', () => {
    const idx = buildAssetIndex([
      ev('a1', 'image', 1),
      ev('a2', 'image', 2),
      ev('v1', 'video', 3),
    ])
    expect(idx.all().map((e) => e.handle)).toEqual(['image_1', 'image_2', 'video_1'])
    expect(idx.all().map((e) => e.sequence)).toEqual([1, 2, 1])
  })

  it('respects host-supplied handle, still advances counter', () => {
    const idx = buildAssetIndex([
      ev('a1', 'image', 1, { handle: 'cat.png' }),
      ev('a2', 'image', 2),
    ])
    expect(idx.resolve('cat.png')?.assetId).toBe('a1')
    // counter advanced past the named entry → second image is image_2
    expect(idx.resolve('image_2')?.assetId).toBe('a2')
  })

  it('sorts by orderHint (input order irrelevant)', () => {
    const idx = buildAssetIndex([ev('a2', 'image', 5), ev('a1', 'image', 1)])
    expect(idx.all().map((e) => e.assetId)).toEqual(['a1', 'a2'])
  })

  it('resolve returns undefined for unknown handle (anti-forgery edge)', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    expect(idx.resolve('image_99')).toBeUndefined()
  })

  it('carries batchId + label onto entries', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1, { batchId: 'call_7', label: 'a cat' })])
    const e = idx.resolve('image_1')
    expect(e?.batchId).toBe('call_7')
    expect(e?.label).toBe('a cat')
  })
})

describe('AssetIndex.query', () => {
  const idx = buildAssetIndex([
    ev('cat1', 'image', 1, { batchId: 'call_1' }),
    ev('cat2', 'image', 2, { batchId: 'call_1' }),
    ev('cat3', 'image', 3, { batchId: 'call_1' }),
    ev('dog1', 'image', 4, { batchId: 'call_2' }),
  ])

  it('latestOfModality: returns the most recent single asset', () => {
    const r = idx.query({ modality: 'image', mode: 'latestOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['dog1'])
  })

  it('latestBatchOfModality: returns every asset in the most recent batch', () => {
    const r = idx.query({ modality: 'image', mode: 'latestBatchOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['dog1']) // call_2 holds only one
  })

  it('latestBatchOfModality: returns all three when the most recent batch has three', () => {
    const catsOnly = buildAssetIndex([
      ev('cat1', 'image', 1, { batchId: 'call_1' }),
      ev('cat2', 'image', 2, { batchId: 'call_1' }),
      ev('cat3', 'image', 3, { batchId: 'call_1' }),
    ])
    const r = catsOnly.query({ modality: 'image', mode: 'latestBatchOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['cat1', 'cat2', 'cat3'])
  })

  it('unknown modality → empty array', () => {
    expect(idx.query({ modality: 'audio', mode: 'latestOfModality' })).toEqual([])
  })

  it('latestBatchOfModality degrades to a single latest asset when no batchId is set', () => {
    const noBatch = buildAssetIndex([ev('a1', 'image', 1), ev('a2', 'image', 2)])
    const r = noBatch.query({ modality: 'image', mode: 'latestBatchOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['a2'])
  })
})

const NEED_SRC_SINGLE: AssetNeed = { slot: 'source', modality: 'image', cardinality: 'single', required: true }
const NEED_SRC_ARRAY: AssetNeed = { slot: 'source', modality: 'image', cardinality: 'array', required: true, max: 2 }

describe('resolveAssetReferences', () => {
  const idx = buildAssetIndex([
    ev('cat1', 'image', 1, { batchId: 'c1' }),
    ev('cat2', 'image', 2, { batchId: 'c1' }),
    ev('vid1', 'video', 3),
  ])

  it('LLM-supplied handle → real assetId injected, and the resolved ref carries the source handle', () => {
    const r = resolveAssetReferences({ references: { source: 'image_2' } }, [NEED_SRC_SINGLE], idx)
    // Explicit-handle path (index.resolve): the resolved ref carries back the handle it resolved from.
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }] })
  })

  it('omitted references + single → defaults to the most recent asset, resolved ref carries the defaulted handle', () => {
    const r = resolveAssetReferences({}, [NEED_SRC_SINGLE], idx)
    // Defaulting path (index.query latestOfModality): the handle is projected into the resolved ref just the same.
    expect(r.ok && r.assets).toEqual([{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }])
  })

  it('omitted references + array → defaults to the whole most recent batch, each entry carrying its handle', () => {
    const r = resolveAssetReferences({}, [NEED_SRC_ARRAY], idx)
    expect(r.ok && r.assets).toEqual([
      { slot: 'source', assetId: 'cat1', modality: 'image', handle: 'image_1' },
      { slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' },
    ])
  })

  it('HANDLE_NOT_FOUND: a handle that does not exist', () => {
    const r = resolveAssetReferences({ references: { source: 'image_99' } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('HANDLE_NOT_FOUND')
      if (r.error.code === 'HANDLE_NOT_FOUND') {
        expect(r.error.handle).toBe('image_99')
        expect(r.error.meta.available.map((s) => s.handle)).toContain('image_1')
        expect(r.error.meta.byModality.image.length).toBe(2)
      }
    }
  })

  it('empty-string reference = an explicit non-selection: optional slot is skipped, no HANDLE_NOT_FOUND', () => {
    // LLMs routinely fill an optional slot with "" instead of omitting the
    // field (a real case: text-to-image's control/reference slots) — a blank
    // reference must not break the whole generation.
    const optional: AssetNeed = { slot: 'control', modality: 'image', cardinality: 'single', required: false }
    const r = resolveAssetReferences({ references: { control: '' } }, [optional], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('a whitespace-only reference behaves like an empty string (optional slot skipped)', () => {
    const optional: AssetNeed = { slot: 'control', modality: 'image', cardinality: 'single', required: false }
    const r = resolveAssetReferences({ references: { control: '  ' } }, [optional], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('empty-string reference on a required slot → REQUIRED_ASSET_MISSING (an explicit empty selection never falls back to the default)', () => {
    const r = resolveAssetReferences({ references: { source: '' } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('REQUIRED_ASSET_MISSING')
  })

  it('empty strings mixed into an array → filtered out, only the valid handles resolve', () => {
    const r = resolveAssetReferences({ references: { source: ['image_1', ''] } }, [NEED_SRC_ARRAY], idx)
    expect(r.ok && r.assets.map((a) => a.handle)).toEqual(['image_1'])
  })

  it('MODALITY_MISMATCH: a video handle in an image slot', () => {
    const r = resolveAssetReferences({ references: { source: 'video_1' } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'MODALITY_MISMATCH') {
      expect(r.error.meta.expected).toBe('image')
      expect(r.error.meta.actual).toBe('video')
      expect(r.error.meta.sameModalityAvailable.map((s) => s.handle)).toEqual(['image_1', 'image_2'])
    } else {
      throw new Error('expected MODALITY_MISMATCH')
    }
  })

  it('REQUIRED_ASSET_MISSING: required slot with no same-modality candidate', () => {
    const empty = buildAssetIndex([])
    const r = resolveAssetReferences({}, [NEED_SRC_SINGLE], empty)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'REQUIRED_ASSET_MISSING') {
      expect(r.error.slot).toBe('source')
      expect(r.error.meta.hint).toBe('upload-or-generate')
    } else {
      throw new Error('expected REQUIRED_ASSET_MISSING')
    }
  })

  it('CARDINALITY_VIOLATION: several handles for a single-cardinality slot', () => {
    const r = resolveAssetReferences({ references: { source: ['image_1', 'image_2'] } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'CARDINALITY_VIOLATION') {
      expect(r.error.meta.got).toBe(2)
      expect(r.error.meta.expected).toBe('single')
    } else {
      throw new Error('expected CARDINALITY_VIOLATION')
    }
  })

  it('CARDINALITY_VIOLATION: array exceeds max', () => {
    const big = buildAssetIndex([ev('a', 'image', 1), ev('b', 'image', 2), ev('c', 'image', 3)])
    const r = resolveAssetReferences({ references: { source: ['image_1', 'image_2', 'image_3'] } }, [NEED_SRC_ARRAY], big)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'CARDINALITY_VIOLATION') {
      expect(r.error.meta.got).toBe(3)
    } else {
      throw new Error('expected CARDINALITY_VIOLATION')
    }
  })

  it('optional slot omitted with no candidate → ok, and the slot produces nothing', () => {
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    const empty = buildAssetIndex([])
    const r = resolveAssetReferences({}, [need], empty)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('optional slot omitted while a same-modality candidate exists → still not auto-filled (defaulting applies to required slots only)', () => {
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    // idx does hold image candidates (cat1/cat2); an omitted optional slot
    // means "none wanted" — never auto-fill it from the most recent
    // same-modality asset.
    const r = resolveAssetReferences({}, [need], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('real i2i shape: omitted references + [source required, mask optional, reference optional] → only source resolves, the optional slots are not mis-filled with that same image', () => {
    const needs: AssetNeed[] = [
      { slot: 'source', modality: 'image', cardinality: 'single', required: true },
      { slot: 'mask', modality: 'image', cardinality: 'single', required: false },
      { slot: 'reference', modality: 'image', cardinality: 'array', required: false },
    ]
    const r = resolveAssetReferences({}, needs, idx)
    expect(r.ok && r.assets.map((a) => ({ slot: a.slot, assetId: a.assetId }))).toEqual([
      { slot: 'source', assetId: 'cat2' },
    ])
  })

  it('an asset:// uri normalizes to a bare handle and resolves', () => {
    const r = resolveAssetReferences({ references: { source: 'asset://image_2' } }, [NEED_SRC_SINGLE], idx)
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }] })
  })

  it('a percent-encoded filename handle inside an asset:// uri decodes and resolves', () => {
    const named = buildAssetIndex([ev('photo-real', 'image', 1, { handle: 'my photo.png' })])
    const r = resolveAssetReferences({ references: { source: 'asset://my%20photo.png' } }, [NEED_SRC_SINGLE], named)
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'photo-real', modality: 'image', handle: 'my photo.png' }] })
  })
})

describe('projectAssetsForModel', () => {
  it('exposes handle/modality/label only — assetId is physically absent (hard projection)', () => {
    const idx = buildAssetIndex([ev('secret-real-id', 'image', 1, { label: 'a cat' })])
    const projected = projectAssetsForModel(idx.all())
    expect(projected).toEqual([{ handle: 'image_1', uri: 'asset://image_1', modality: 'image', label: 'a cat' }])
    expect(JSON.stringify(projected)).not.toContain('secret-real-id')
  })

  it('omits the label field when there is no label', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    expect(projectAssetsForModel(idx.all())).toEqual([{ handle: 'image_1', uri: 'asset://image_1', modality: 'image' }])
  })

  it('exposes the asset:// uri alongside the handle (the handle is kept, not replaced)', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    expect(projectAssetsForModel(idx.all())[0].uri).toBe('asset://image_1')
  })

  it('a configured scheme is emitted by both projection paths', () => {
    setAssetUriScheme('host://')
    try {
      const idx = buildAssetIndex([ev('a1', 'image', 1)])
      expect(projectAssetsForModel(idx.all())[0].uri).toBe('host://image_1')
      const out = projectToolOutputForModel({
        assets: [{ handle: 'image_3', modality: 'image', assetId: 'a-1' }],
      }) as { assets: { uri: string }[] }
      expect(out.assets[0].uri).toBe('host://image_3')
      // And the reverse direction: the configured scheme is the one the resolve side accepts.
      const r = resolveAssetReferences({ references: { source: 'host://image_1' } }, [NEED_SRC_SINGLE], idx)
      expect(r.ok && r.assets[0].handle).toBe('image_1')
    } finally {
      setAssetUriScheme('asset://')
    }
  })
})

describe('asset-index review regressions', () => {
  it('explicit [] on a required slot → REQUIRED_ASSET_MISSING (no silent fall-through to the default)', () => {
    const idx = buildAssetIndex([ev('cat1', 'image', 1)])
    const r = resolveAssetReferences({ references: { source: [] } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'REQUIRED_ASSET_MISSING') {
      expect(r.error.meta.hint).toBe('reference-from-history')
    } else {
      throw new Error('expected REQUIRED_ASSET_MISSING')
    }
  })

  it('explicit [] on an optional slot → ok and produces nothing (no defaulting)', () => {
    const idx = buildAssetIndex([ev('cat1', 'image', 1)])
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    expect(resolveAssetReferences({ references: { mask: [] } }, [need], idx)).toEqual({ ok: true, assets: [] })
  })

  // The two tests below used to pin "later orderHint wins" for two DIFFERENT
  // assets sharing a handle — i.e. they asserted the exact silent drop that
  // HANDLE_COLLISION now refuses. Later-wins survives only for a replay of the
  // same asset; the collision block further down covers the other half.
  it('same handle replayed for the same asset: handles stay unique in all(), the later replay wins, and no ghost entry is left behind', () => {
    const idx = buildAssetIndex([
      ev('a1', 'image', 1, { handle: 'cat.png', label: 'first announcement' }),
      ev('a1', 'image', 2, { handle: 'cat.png', label: 'replayed with a better label' }),
    ])
    const handles = idx.all().map((e) => e.handle)
    expect(new Set(handles).size).toBe(handles.length)
    expect(idx.all()).toHaveLength(1)
    expect(idx.resolve('cat.png')?.label).toBe('replayed with a better label')
  })

  it('same handle, same asset: the winner is by orderHint, not array position', () => {
    const idx = buildAssetIndex([
      ev('same', 'image', 2, { handle: 'dup', label: 'new' }),
      ev('same', 'image', 1, { handle: 'dup', label: 'old' }),
    ])
    expect(idx.resolve('dup')?.label).toBe('new')
  })

  it('all() returns a defensive copy (external mutation does not leak)', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    const snap = idx.all() as AssetLedgerEntry[]
    snap.push({ handle: 'evil', assetId: 'x', modality: 'image', sequence: 99 })
    expect(idx.all()).toHaveLength(1)
  })

  it('fail-closed across needs: an earlier need resolving + a later need with a bad handle → the whole resolve fails', () => {
    const idx = buildAssetIndex([ev('cat', 'image', 1), ev('vid', 'video', 2)])
    const needs: AssetNeed[] = [
      { slot: 'source', modality: 'image', cardinality: 'single', required: true },
      { slot: 'aux', modality: 'video', cardinality: 'single', required: true },
    ]
    const r = resolveAssetReferences({ references: { source: 'image_1', aux: 'video_99' } }, needs, idx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('HANDLE_NOT_FOUND')
    } else {
      throw new Error('expected fail')
    }
  })

  it('latestBatchOfModality still filters by modality when one batchId is shared across modalities', () => {
    const idx = buildAssetIndex([
      ev('img1', 'image', 1, { batchId: 'b1' }),
      ev('vid1', 'video', 2, { batchId: 'b1' }),
      ev('img2', 'image', 3, { batchId: 'b1' }),
    ])
    expect(idx.query({ modality: 'image', mode: 'latestBatchOfModality' }).map((e) => e.assetId)).toEqual(['img1', 'img2'])
  })
})

describe('UNKNOWN_SLOT (fail-closed for undeclared reference keys)', () => {
  const needs: AssetNeed[] = [
    { slot: 'source', modality: 'image', cardinality: 'array', required: true },
    { slot: 'mask', modality: 'image', cardinality: 'single', required: false },
  ]
  const index = buildAssetIndex([
    { kind: 'asset', annotation: { assetId: 'a1', modality: 'image' }, orderHint: 0 },
  ])

  it('rejects a typo slot key instead of silently falling back to defaults', () => {
    const r = resolveAssetReferences({ references: { styleref: 'image_1' } }, needs, index)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_SLOT')
      if (r.error.code === 'UNKNOWN_SLOT') {
        expect(r.error.slot).toBe('styleref')
        expect(r.error.meta.declaredSlots).toEqual(['source', 'mask'])
        expect(r.error.meta.available).toHaveLength(1)
      }
    }
  })

  it('rejects any reference key when the pattern declares no assetNeeds', () => {
    const r = resolveAssetReferences({ references: { source: 'image_1' } }, [], index)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_SLOT')
  })

  it('declared keys still resolve (no regression)', () => {
    const r = resolveAssetReferences({ references: { source: 'image_1' } }, needs, index)
    expect(r.ok).toBe(true)
  })
})

// The pure function behind the toModelOutput landing point. The checkable
// assertion: after projection JSON.stringify carries no real assetId, so the
// model-visible side cannot read the truth.
describe('projectToolOutputForModel — assetId is structurally absent', () => {
  it('strips assetId from each assets[] element, keeps handle/modality/label', () => {
    const full = {
      modality: 'image',
      assets: [
        { handle: 'image_1', assetId: 'real-1', modality: 'image', url: 'https://x/1', cost: 0.01 },
        { handle: 'image_2', assetId: 'real-2', modality: 'image', label: 'a cat' },
      ],
      cost: 0.02,
      model: 'p:m',
      provider: 'p',
    }
    const projected = projectToolOutputForModel(full)
    expect(projected).toEqual({
      modality: 'image',
      assets: [
        { handle: 'image_1', uri: 'asset://image_1', modality: 'image' },
        { handle: 'image_2', uri: 'asset://image_2', modality: 'image', label: 'a cat' },
      ],
      cost: 0.02,
      model: 'p:m',
      provider: 'p',
    })
    // The load-bearing assertion: no real assetId survives serialization.
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('real-1')
    expect(serialized).not.toContain('real-2')
    expect(serialized).not.toContain('assetId')
    // url is also gone (it was a locator on the asset element).
    expect(serialized).not.toContain('https://x/1')
  })

  it('drops legacy top-level assetId field entirely', () => {
    const full = { modality: 'image', assetId: 'legacy-id', assets: [], cost: 0 }
    const projected = projectToolOutputForModel(full) as Record<string, unknown>
    expect('assetId' in projected).toBe(false)
    expect(JSON.stringify(projected)).not.toContain('legacy-id')
  })

  it('passes non-asset (text) outputs through unchanged', () => {
    const textOut = { modality: 'text', text: 'a transcript', cost: 0.001, model: 'p:m', provider: 'p' }
    expect(projectToolOutputForModel(textOut)).toBe(textOut)
  })

  it('passes through structured error tool-results (no assets[])', () => {
    const err = { code: 'JOB_FAILED', pattern_id: 'text-to-image', message: 'boom' }
    expect(projectToolOutputForModel(err)).toBe(err)
  })

  it('handles non-object inputs defensively', () => {
    expect(projectToolOutputForModel(null)).toBeNull()
    expect(projectToolOutputForModel('s')).toBe('s')
    expect(projectToolOutputForModel(42)).toBe(42)
  })

  it('exposes asset:// uri alongside handle and drops assetId on each element', () => {
    const projected = projectToolOutputForModel({
      assets: [{ handle: 'image_3', modality: 'image', assetId: 'a-1' }],
    }) as { assets: Record<string, unknown>[] }
    expect(projected.assets[0].uri).toBe('asset://image_3')
    expect(projected.assets[0].assetId).toBeUndefined()
  })

  it('preserves host-set origin/from but keeps from handle+role only', () => {
    const full = {
      modality: 'image',
      assets: [
        {
          handle: 'image_5',
          assetId: 'child-5',
          modality: 'image',
          origin: 'generated',
          // dirty from-entries: a stray assetId/url must NOT survive; an entry
          // missing handle must be dropped.
          from: [
            { handle: 'image_2', role: 'source', assetId: 'parent-2', url: 'https://x/2' },
            { handle: 'image_3', role: 'mask' },
            { role: 'style' },
          ],
        },
      ],
      cost: 0,
    }
    const projected = projectToolOutputForModel(full) as { assets: unknown[] }
    expect(projected.assets[0]).toEqual({
      handle: 'image_5',
      uri: 'asset://image_5',
      modality: 'image',
      origin: 'generated',
      from: [
        { handle: 'image_2', role: 'source' },
        { handle: 'image_3', role: 'mask' },
      ],
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('child-5')
    expect(serialized).not.toContain('parent-2')
    expect(serialized).not.toContain('assetId')
    expect(serialized).not.toContain('https://x/2')
  })

  it('omits from when all entries invalid; omits origin unless generated', () => {
    const full = {
      modality: 'image',
      assets: [
        { handle: 'image_9', modality: 'image', origin: 'uploaded', from: [{ role: 'source' }] },
      ],
    }
    const projected = projectToolOutputForModel(full) as { assets: Record<string, unknown>[] }
    expect(projected.assets[0]).toEqual({ handle: 'image_9', uri: 'asset://image_9', modality: 'image' })
  })
})


// A thrown (not returned) failure: pull the Error out so its attached facts
// can be asserted field by field.
function caught(fn: () => unknown): Error & { code?: string; details?: unknown } {
  try {
    fn()
  } catch (e) {
    return e as Error & { code?: string; details?: unknown }
  }
  throw new Error('expected the call to throw')
}

describe('buildAssetIndex — replayed handles and HANDLE_COLLISION', () => {
  it('a replayed mint pulls the counter past itself: image_2 then an unannotated image mints image_3, nothing dropped', () => {
    // The original bug: the counter advanced by event count, so the fresh
    // mint after a replayed `image_2` was `image_2` again and the replayed
    // asset silently vanished behind it.
    const idx = buildAssetIndex([ev('A', 'image', 1, { handle: 'image_2' }), ev('B', 'image', 2)])
    expect(idx.all().map((e) => [e.handle, e.assetId, e.sequence])).toEqual([
      ['image_2', 'A', 2],
      ['image_3', 'B', 3],
    ])
    expect(idx.resolve('image_2')?.assetId).toBe('A')
    expect(idx.resolve('image_3')?.assetId).toBe('B')
  })

  it('a replayed ordinal below the counter does not wind it back', () => {
    const idx = buildAssetIndex([
      ev('A', 'image', 1, { handle: 'image_5' }),
      ev('B', 'image', 2, { handle: 'image_3' }),
      ev('C', 'image', 3),
    ])
    expect(idx.all().map((e) => [e.handle, e.sequence])).toEqual([
      ['image_5', 5],
      ['image_3', 3],
      ['image_6', 6],
    ])
  })

  it('HANDLE_COLLISION: a host replay of image_1 for a different asset, after this context already minted image_1', () => {
    const err = caught(() =>
      buildAssetIndex([ev('a1', 'image', 1), ev('a2', 'image', 2), ev('c', 'image', 3, { handle: 'image_1' })]),
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message.startsWith('HANDLE_COLLISION:')).toBe(true)
    expect(err.code).toBe('HANDLE_COLLISION')
    expect(err.details).toEqual({ handle: 'image_1', modality: 'image', assetIds: ['a1', 'c'] })
  })

  it('HANDLE_COLLISION: two host-provided entries with the same handle but different assetIds (never a silent later-wins)', () => {
    const err = caught(() =>
      buildAssetIndex([ev('a1', 'image', 1, { handle: 'cat.png' }), ev('a2', 'image', 2, { handle: 'cat.png' })]),
    )
    expect(err.code).toBe('HANDLE_COLLISION')
    expect(err.details).toEqual({ handle: 'cat.png', modality: 'image', assetIds: ['a1', 'a2'] })
  })

  it('HANDLE_COLLISION reports the pair in orderHint order, not array order', () => {
    const err = caught(() =>
      buildAssetIndex([ev('later', 'image', 9, { handle: 'dup' }), ev('earlier', 'image', 1, { handle: 'dup' })]),
    )
    expect(err.details).toEqual({ handle: 'dup', modality: 'image', assetIds: ['earlier', 'later'] })
  })

  it('same handle + same assetId replayed twice → no throw, one entry', () => {
    const idx = buildAssetIndex([ev('A', 'image', 1, { handle: 'image_1' }), ev('A', 'image', 2, { handle: 'image_1' })])
    expect(idx.all()).toHaveLength(1)
    expect(idx.resolve('image_1')?.assetId).toBe('A')
  })

  it('a host replay of the handle this context itself minted for the same asset is idempotent, and minting continues past it', () => {
    const idx = buildAssetIndex([ev('A', 'image', 1), ev('A', 'image', 2, { handle: 'image_1' }), ev('B', 'image', 3)])
    expect(idx.all().map((e) => [e.handle, e.assetId])).toEqual([
      ['image_1', 'A'],
      ['image_2', 'B'],
    ])
  })

  it('a host handle outside the minted grammar (hero-shot) takes the next slot and leaves the counter alone', () => {
    const idx = buildAssetIndex([ev('A', 'image', 1, { handle: 'hero-shot' }), ev('B', 'image', 2)])
    expect(idx.all().map((e) => [e.handle, e.sequence])).toEqual([
      ['hero-shot', 1],
      ['image_2', 2],
    ])
    expect(idx.resolve('hero-shot')?.assetId).toBe('A')
  })

  it("another modality's mint on this event is an opaque name: video_3 on an image does not steer the image counter", () => {
    const idx = buildAssetIndex([ev('A', 'image', 1, { handle: 'video_3' }), ev('B', 'image', 2), ev('V', 'video', 3)])
    expect(idx.all().map((e) => [e.handle, e.sequence])).toEqual([
      ['video_3', 1],
      ['image_2', 2],
      ['video_1', 1],
    ])
  })
})
