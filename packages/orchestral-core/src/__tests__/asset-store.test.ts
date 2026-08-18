// InMemoryAssetStore 单测:record(mint / cap-closed / referenceable / 幂等 / 提升)+ listContext。
import { describe, expect, it } from 'vitest'
import { InMemoryAssetStore } from '../asset-store'

describe('InMemoryAssetStore.record', () => {
  it('referenceable 默认 true,cap 开(无 handle)→ mint image_1 + seq 1', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect(rec.handle).toBe('image_1')
    expect(rec.seq).toBe(1)
    expect(rec.referenceable).toBe(true)
    expect(rec.assetId).toBe('a1')
  })

  it('per-(context,modality) 计数:第二张 image → image_2;首个 video → video_1', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const a2 = await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    const v1 = await s.record('chat1', { assetId: 'v1', modality: 'video', origin: 'tool-output' })
    expect(a2.handle).toBe('image_2')
    expect(v1.handle).toBe('video_1')
  })

  it('cap 关:host 传 handle = assetId → 采用该 handle,计数仍前进', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chat1', { assetId: 'uuid-x', modality: 'image', origin: 'upload', handle: 'uuid-x' })
    expect(rec.handle).toBe('uuid-x')
    expect(rec.seq).toBe(1)
  })

  it('referenceable=false → 不 mint(无 handle/seq),不消耗计数(N16)', async () => {
    const s = new InMemoryAssetStore()
    const mid = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    expect(mid.referenceable).toBe(false)
    expect(mid.handle).toBeUndefined()
    expect(mid.seq).toBeUndefined()
    const real = await s.record('chat1', { assetId: 'real', modality: 'image', origin: 'tool-output' })
    expect(real.handle).toBe('image_1')
  })

  it('幂等:同 (context, assetId) 二次 record → 返回原记录,计数不增(N5)', async () => {
    const s = new InMemoryAssetStore()
    const first = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const again = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect(again.handle).toBe(first.handle)
    const a2 = await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    expect(a2.handle).toBe('image_2')
  })

  it('单调提升:false 记录被以 true 再 record → 提升那刻补 mint(N16)', async () => {
    const s = new InMemoryAssetStore()
    const mid = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    expect(mid.handle).toBeUndefined()
    await s.record('chat1', { assetId: 'real', modality: 'image', origin: 'tool-output' })
    const promoted = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'tool-output', referenceable: true })
    expect(promoted.referenceable).toBe(true)
    expect(promoted.handle).toBe('image_2')
  })

  it('owner 是 write-only:作为输入被接受,但不回填到记录上(agent 场景用)', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('run7', { assetId: 'd1', modality: 'image', origin: 'tool-output', owner: 'chatA' })
    // owner 不挂在只读记录上
    expect('owner' in rec).toBe(false)
    // 资产照常记录
    expect(rec.assetId).toBe('d1')
    expect(rec.handle).toBe('image_1')
  })

  it('省略 owner → 记录同样不带 owner,资产照常记录', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chatA', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect('owner' in rec).toBe(false)
    expect(rec.assetId).toBe('a1')
    expect(rec.handle).toBe('image_1')
  })
})

describe('InMemoryAssetStore.listContext', () => {
  it('oldest-first(插入序);默认只返回 referenceable=true', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    const out = await s.listContext('chat1')
    expect(out.map((r) => r.assetId)).toEqual(['a1', 'a2'])
  })

  it('includeNonReferenceable:true → 含中间产物', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    const out = await s.listContext('chat1', { includeNonReferenceable: true })
    expect(out.map((r) => r.assetId)).toEqual(['a1', 'mid'])
  })

  it('origins 过滤:只取 upload/workflow', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'tool', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'up', modality: 'image', origin: 'upload' })
    const out = await s.listContext('chat1', { origins: ['upload', 'workflow'] })
    expect(out.map((r) => r.assetId)).toEqual(['up'])
  })

  it('未知 context → 空数组', async () => {
    const s = new InMemoryAssetStore()
    expect(await s.listContext('nope')).toEqual([])
  })

  it('返回防御性拷贝:改返回值不污染 store 内部', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const out = await s.listContext('chat1')
    out[0].handle = 'TAMPERED'
    const again = await s.listContext('chat1')
    expect(again[0].handle).toBe('image_1')
  })
})
