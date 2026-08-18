// AssetLedger P1 原语单测(mintHandle / buildAssetIndex / query / resolveAssetReferences / projectAssetsForModel)。
import { describe, expect, it } from 'vitest'

import { buildAssetIndex, mintHandle, projectAssetsForModel, projectToolOutputForModel, resolveAssetReferences } from '../asset-index'
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
  // 猫(call_1 批 3 张)→ 狗(call_2 批 1 张)
  const idx = buildAssetIndex([
    ev('cat1', 'image', 1, { batchId: 'call_1' }),
    ev('cat2', 'image', 2, { batchId: 'call_1' }),
    ev('cat3', 'image', 3, { batchId: 'call_1' }),
    ev('dog1', 'image', 4, { batchId: 'call_2' }),
  ])

  it('latestOfModality: 取最近一个', () => {
    const r = idx.query({ modality: 'image', mode: 'latestOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['dog1'])
  })

  it('latestBatchOfModality: 取最近批次全部', () => {
    const r = idx.query({ modality: 'image', mode: 'latestBatchOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['dog1']) // call_2 只有 1 张
  })

  it('latestBatchOfModality: 最近批次是猫的 3 张时全取', () => {
    const catsOnly = buildAssetIndex([
      ev('cat1', 'image', 1, { batchId: 'call_1' }),
      ev('cat2', 'image', 2, { batchId: 'call_1' }),
      ev('cat3', 'image', 3, { batchId: 'call_1' }),
    ])
    const r = catsOnly.query({ modality: 'image', mode: 'latestBatchOfModality' })
    expect(r.map((e) => e.assetId)).toEqual(['cat1', 'cat2', 'cat3'])
  })

  it('无该 modality → 空数组', () => {
    expect(idx.query({ modality: 'audio', mode: 'latestOfModality' })).toEqual([])
  })

  it('latestBatchOfModality 在无 batchId 时退化为 latest 单个', () => {
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

  it('LLM 填 handle → 注入真 assetId,且 resolved ref 携带源 handle', () => {
    const r = resolveAssetReferences({ references: { source: 'image_2' } }, [NEED_SRC_SINGLE], idx)
    // 显式 handle 解析路径(index.resolve):resolved ref 回带它解析自的 handle。
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }] })
  })

  it('省略 references + single → 默认取最近一个,resolved ref 带默认填充槽的 handle', () => {
    const r = resolveAssetReferences({}, [NEED_SRC_SINGLE], idx)
    // 默认填充路径(index.query latestOfModality):handle 同样投影进 resolved ref。
    expect(r.ok && r.assets).toEqual([{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }])
  })

  it('省略 references + array → 默认取最近批次全部,每条带 handle', () => {
    const r = resolveAssetReferences({}, [NEED_SRC_ARRAY], idx)
    expect(r.ok && r.assets).toEqual([
      { slot: 'source', assetId: 'cat1', modality: 'image', handle: 'image_1' },
      { slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' },
    ])
  })

  it('HANDLE_NOT_FOUND: 填了不存在的 handle', () => {
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

  it('空串引用 = 显式不选择:可选槽跳过,不报 HANDLE_NOT_FOUND', () => {
    // LLM 常给可选槽填 "" 而不是省略字段(真实 case:text-to-image 的
    // control/reference 槽)——空白引用不该打断整次生成。
    const optional: AssetNeed = { slot: 'control', modality: 'image', cardinality: 'single', required: false }
    const r = resolveAssetReferences({ references: { control: '' } }, [optional], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('纯空白串引用同空串(可选槽跳过)', () => {
    const optional: AssetNeed = { slot: 'control', modality: 'image', cardinality: 'single', required: false }
    const r = resolveAssetReferences({ references: { control: '  ' } }, [optional], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('空串引用 + 必填槽 → REQUIRED_ASSET_MISSING(显式空选择,不默认填充)', () => {
    const r = resolveAssetReferences({ references: { source: '' } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('REQUIRED_ASSET_MISSING')
  })

  it('数组里混空串 → 过滤后只解析有效 handle', () => {
    const r = resolveAssetReferences({ references: { source: ['image_1', ''] } }, [NEED_SRC_ARRAY], idx)
    expect(r.ok && r.assets.map((a) => a.handle)).toEqual(['image_1'])
  })

  it('MODALITY_MISMATCH: image 槽填 video handle', () => {
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

  it('REQUIRED_ASSET_MISSING: 必填但无同模态候选', () => {
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

  it('CARDINALITY_VIOLATION: single 槽给了多个', () => {
    const r = resolveAssetReferences({ references: { source: ['image_1', 'image_2'] } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'CARDINALITY_VIOLATION') {
      expect(r.error.meta.got).toBe(2)
      expect(r.error.meta.expected).toBe('single')
    } else {
      throw new Error('expected CARDINALITY_VIOLATION')
    }
  })

  it('CARDINALITY_VIOLATION: array 超 max', () => {
    const big = buildAssetIndex([ev('a', 'image', 1), ev('b', 'image', 2), ev('c', 'image', 3)])
    const r = resolveAssetReferences({ references: { source: ['image_1', 'image_2', 'image_3'] } }, [NEED_SRC_ARRAY], big)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'CARDINALITY_VIOLATION') {
      expect(r.error.meta.got).toBe(3)
    } else {
      throw new Error('expected CARDINALITY_VIOLATION')
    }
  })

  it('optional 槽省略且无候选 → ok、该 slot 不产出', () => {
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    const empty = buildAssetIndex([])
    const r = resolveAssetReferences({}, [need], empty)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('optional 槽省略但有同模态候选 → 不自动填充(默认规则只对必填槽生效)', () => {
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    // idx 有 image 候选(cat1/cat2);可选槽省略 = "不要",绝不从同模态最近资产自动填充
    const r = resolveAssetReferences({}, [need], idx)
    expect(r).toEqual({ ok: true, assets: [] })
  })

  it('i2i 实景:省略 references + [source必填, mask可选, reference可选] → 只解析 source,可选槽不被同一张图误填', () => {
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

  it('asset:// uri 归一化到裸 handle 后正常解析', () => {
    const r = resolveAssetReferences({ references: { source: 'asset://image_2' } }, [NEED_SRC_SINGLE], idx)
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'cat2', modality: 'image', handle: 'image_2' }] })
  })

  it('asset:// uri 的百分号编码文件名 handle 解码后解析', () => {
    const named = buildAssetIndex([ev('photo-real', 'image', 1, { handle: 'my photo.png' })])
    const r = resolveAssetReferences({ references: { source: 'asset://my%20photo.png' } }, [NEED_SRC_SINGLE], named)
    expect(r).toEqual({ ok: true, assets: [{ slot: 'source', assetId: 'photo-real', modality: 'image', handle: 'my photo.png' }] })
  })
})

describe('projectAssetsForModel', () => {
  it('只露 handle/modality/label,assetId 物理缺席(硬投影 §6.3)', () => {
    const idx = buildAssetIndex([ev('secret-real-id', 'image', 1, { label: 'a cat' })])
    const projected = projectAssetsForModel(idx.all())
    expect(projected).toEqual([{ handle: 'image_1', uri: 'asset://image_1', modality: 'image', label: 'a cat' }])
    // assetId 绝不出现在投影里
    expect(JSON.stringify(projected)).not.toContain('secret-real-id')
  })

  it('无 label 时不带 label 字段', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    expect(projectAssetsForModel(idx.all())).toEqual([{ handle: 'image_1', uri: 'asset://image_1', modality: 'image' }])
  })

  it('并列露出 asset:// uri(handle 保留不删)', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    expect(projectAssetsForModel(idx.all())[0].uri).toBe('asset://image_1')
  })

  it('配置了 scheme 后,两条投影路径都产出该 scheme', () => {
    setAssetUriScheme('host://')
    try {
      const idx = buildAssetIndex([ev('a1', 'image', 1)])
      expect(projectAssetsForModel(idx.all())[0].uri).toBe('host://image_1')
      const out = projectToolOutputForModel({
        assets: [{ handle: 'image_3', modality: 'image', assetId: 'a-1' }],
      }) as { assets: { uri: string }[] }
      expect(out.assets[0].uri).toBe('host://image_3')
      // 反向:配置后的 scheme 也是解析侧认的那个
      const r = resolveAssetReferences({ references: { source: 'host://image_1' } }, [NEED_SRC_SINGLE], idx)
      expect(r.ok && r.assets[0].handle).toBe('image_1')
    } finally {
      setAssetUriScheme('asset://')
    }
  })
})

describe('asset-index review regressions', () => {
  // C1: 显式空数组对 required 槽 fail-closed
  it('required 槽显式 [] → REQUIRED_ASSET_MISSING(不静默走默认)', () => {
    const idx = buildAssetIndex([ev('cat1', 'image', 1)])
    const r = resolveAssetReferences({ references: { source: [] } }, [NEED_SRC_SINGLE], idx)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.code === 'REQUIRED_ASSET_MISSING') {
      expect(r.error.meta.hint).toBe('reference-from-history')
    } else {
      throw new Error('expected REQUIRED_ASSET_MISSING')
    }
  })

  it('optional 槽显式 [] → ok 且不产出(不走默认)', () => {
    const idx = buildAssetIndex([ev('cat1', 'image', 1)])
    const need: AssetNeed = { slot: 'mask', modality: 'image', cardinality: 'single', required: false }
    expect(resolveAssetReferences({ references: { mask: [] } }, [need], idx)).toEqual({ ok: true, assets: [] })
  })

  // I1: 同 host handle 冲突,resolve 与 all 一致、无幽灵
  it('同 host handle 冲突:all() 内 handle 单射,resolve 取后者,无不可达幽灵', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1, { handle: 'cat.png' }), ev('a2', 'image', 2, { handle: 'cat.png' })])
    const handles = idx.all().map((e) => e.handle)
    expect(new Set(handles).size).toBe(handles.length)
    expect(idx.resolve('cat.png')?.assetId).toBe('a2')
  })

  // C-1: later-wins 由 orderHint 决定,非数组位置
  it('same handle winner is by orderHint, not array position', () => {
    const idx = buildAssetIndex([ev('new', 'image', 2, { handle: 'dup' }), ev('old', 'image', 1, { handle: 'dup' })])
    expect(idx.resolve('dup')?.assetId).toBe('new')
  })

  // C-2: all() 防御拷贝回归护栏
  it('all() returns a defensive copy (external mutation does not leak)', () => {
    const idx = buildAssetIndex([ev('a1', 'image', 1)])
    const snap = idx.all() as AssetLedgerEntry[]
    snap.push({ handle: 'evil', assetId: 'x', modality: 'image', sequence: 99 })
    expect(idx.all()).toHaveLength(1)
  })

  // C-3: 跨多 need fail-closed,前一个成功也不产出半成品
  it('fail-closed across needs: 前 need 成功 + 后 need 坏 handle → 整体失败', () => {
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

  // C-4: latestBatchOfModality 跨模态共享 batchId 时仍按 modality 过滤
  it('latestBatchOfModality 在 batchId 跨模态共享时仍按 modality 过滤', () => {
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

// §6.3 D3 硬投影 — toModelOutput 落点的纯函数。可验断言:投影后 JSON.stringify
// 不含真 assetId(模型可见侧不可能读到真相)。
describe('projectToolOutputForModel (D3 hard projection)', () => {
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

  it('preserves host-set origin/from but keeps from D3-clean (handle+role only)', () => {
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
