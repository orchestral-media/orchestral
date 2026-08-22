// InMemoryAssetStore unit tests: record (mint / cap-closed / referenceable / idempotency / promotion) + listContext.
import { describe, expect, it } from 'vitest'
import { InMemoryAssetStore } from '../asset-store'

describe('InMemoryAssetStore.record', () => {
  it('referenceable defaults to true; with the cap open (no handle) it mints image_1 + seq 1', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect(rec.handle).toBe('image_1')
    expect(rec.seq).toBe(1)
    expect(rec.referenceable).toBe(true)
    expect(rec.assetId).toBe('a1')
  })

  it('per-(context, modality) counters: the second image → image_2, the first video → video_1', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const a2 = await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    const v1 = await s.record('chat1', { assetId: 'v1', modality: 'video', origin: 'tool-output' })
    expect(a2.handle).toBe('image_2')
    expect(v1.handle).toBe('video_1')
  })

  it('cap closed: a host-supplied handle = assetId is adopted, and the counter still advances', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chat1', { assetId: 'uuid-x', modality: 'image', origin: 'upload', handle: 'uuid-x' })
    expect(rec.handle).toBe('uuid-x')
    expect(rec.seq).toBe(1)
  })

  it('referenceable=false → nothing is minted (no handle/seq) and no counter slot is consumed', async () => {
    const s = new InMemoryAssetStore()
    const mid = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    expect(mid.referenceable).toBe(false)
    expect(mid.handle).toBeUndefined()
    expect(mid.seq).toBeUndefined()
    const real = await s.record('chat1', { assetId: 'real', modality: 'image', origin: 'tool-output' })
    expect(real.handle).toBe('image_1')
  })

  it('idempotent: recording the same (context, assetId) twice returns the original record and does not advance the counter', async () => {
    const s = new InMemoryAssetStore()
    const first = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const again = await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect(again.handle).toBe(first.handle)
    const a2 = await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    expect(a2.handle).toBe('image_2')
  })

  it('monotonic promotion: re-recording a false entry as true mints its handle at the moment of promotion', async () => {
    const s = new InMemoryAssetStore()
    const mid = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    expect(mid.handle).toBeUndefined()
    await s.record('chat1', { assetId: 'real', modality: 'image', origin: 'tool-output' })
    const promoted = await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'tool-output', referenceable: true })
    expect(promoted.referenceable).toBe(true)
    expect(promoted.handle).toBe('image_2')
  })

  it('owner is write-only: accepted as input but never written back onto the record (used by the agent path)', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('run7', { assetId: 'd1', modality: 'image', origin: 'tool-output', owner: 'chatA' })
    expect('owner' in rec).toBe(false)
    expect(rec.assetId).toBe('d1')
    expect(rec.handle).toBe('image_1')
  })

  it('omitting owner → the record likewise carries no owner, and the asset is recorded as usual', async () => {
    const s = new InMemoryAssetStore()
    const rec = await s.record('chatA', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    expect('owner' in rec).toBe(false)
    expect(rec.assetId).toBe('a1')
    expect(rec.handle).toBe('image_1')
  })
})

describe('InMemoryAssetStore.listContext', () => {
  it('oldest-first (insertion order); by default only referenceable=true entries are returned', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    const out = await s.listContext('chat1')
    expect(out.map((r) => r.assetId)).toEqual(['a1', 'a2'])
  })

  it('includeNonReferenceable: true → intermediates are included', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    const out = await s.listContext('chat1', { includeNonReferenceable: true })
    expect(out.map((r) => r.assetId)).toEqual(['a1', 'mid'])
  })

  it('origins filter: only upload/workflow are returned', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'tool', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'up', modality: 'image', origin: 'upload' })
    const out = await s.listContext('chat1', { origins: ['upload', 'workflow'] })
    expect(out.map((r) => r.assetId)).toEqual(['up'])
  })

  it('unknown context → empty array', async () => {
    const s = new InMemoryAssetStore()
    expect(await s.listContext('nope')).toEqual([])
  })

  it('returns a defensive copy: mutating the result does not corrupt the store internals', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    const out = await s.listContext('chat1')
    out[0].handle = 'TAMPERED'
    const again = await s.listContext('chat1')
    expect(again[0].handle).toBe('image_1')
  })
})


// A rejected record: pull the Error out so its attached facts can be asserted
// field by field.
async function rejected(p: Promise<unknown>): Promise<Error & { code?: string; details?: unknown }> {
  try {
    await p
  } catch (e) {
    return e as Error & { code?: string; details?: unknown }
  }
  throw new Error('expected the record to reject')
}

describe('InMemoryAssetStore.record — replayed handles and HANDLE_COLLISION', () => {
  it('a replayed mint pulls the counter past itself: image_2 then an unannotated image mints image_3, both listed', async () => {
    const s = new InMemoryAssetStore()
    const a = await s.record('chat1', { assetId: 'A', modality: 'image', origin: 'upload', handle: 'image_2' })
    const b = await s.record('chat1', { assetId: 'B', modality: 'image', origin: 'tool-output' })
    expect([a.handle, a.seq]).toEqual(['image_2', 2])
    expect([b.handle, b.seq]).toEqual(['image_3', 3])
    expect((await s.listContext('chat1')).map((r) => r.handle)).toEqual(['image_2', 'image_3'])
  })

  it('HANDLE_COLLISION: a host replay of image_1 for a different asset after this context minted image_1 — and the store is left untouched', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await s.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    const err = await rejected(s.record('chat1', { assetId: 'c', modality: 'image', origin: 'upload', handle: 'image_1' }))
    expect(err).toBeInstanceOf(Error)
    expect(err.message.startsWith('HANDLE_COLLISION:')).toBe(true)
    expect(err.code).toBe('HANDLE_COLLISION')
    expect(err.details).toEqual({ handle: 'image_1', modality: 'image', assetIds: ['a1', 'c'] })
    // Nothing was written: the refused asset is absent, and the counter did not move.
    expect((await s.listContext('chat1', { includeNonReferenceable: true })).map((r) => r.assetId)).toEqual(['a1', 'a2'])
    const next = await s.record('chat1', { assetId: 'a3', modality: 'image', origin: 'tool-output' })
    expect(next.handle).toBe('image_3')
  })

  it('same handle + same assetId recorded twice → no throw, one record', async () => {
    const s = new InMemoryAssetStore()
    const first = await s.record('chat1', { assetId: 'A', modality: 'image', origin: 'upload', handle: 'image_1' })
    const again = await s.record('chat1', { assetId: 'A', modality: 'image', origin: 'upload', handle: 'image_1' })
    expect(again).toEqual(first)
    expect(await s.listContext('chat1')).toHaveLength(1)
  })

  it('a host handle outside the minted grammar (hero-shot) takes the next slot and leaves the counter alone', async () => {
    const s = new InMemoryAssetStore()
    const a = await s.record('chat1', { assetId: 'A', modality: 'image', origin: 'upload', handle: 'hero-shot' })
    const b = await s.record('chat1', { assetId: 'B', modality: 'image', origin: 'tool-output' })
    expect([a.handle, a.seq]).toEqual(['hero-shot', 1])
    expect([b.handle, b.seq]).toEqual(['image_2', 2])
  })

  it('handles are scoped per context: the same handle in two contexts is not a collision', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'A', modality: 'image', origin: 'upload', handle: 'cat.png' })
    const other = await s.record('chat2', { assetId: 'B', modality: 'image', origin: 'upload', handle: 'cat.png' })
    expect(other.handle).toBe('cat.png')
  })

  it('a promotion whose supplied handle collides is refused, and the record stays unpromoted', async () => {
    const s = new InMemoryAssetStore()
    await s.record('chat1', { assetId: 'owner', modality: 'image', origin: 'upload', handle: 'cat.png' })
    await s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'intermediate', referenceable: false })
    const err = await rejected(
      s.record('chat1', { assetId: 'mid', modality: 'image', origin: 'tool-output', referenceable: true, handle: 'cat.png' }),
    )
    expect(err.code).toBe('HANDLE_COLLISION')
    expect(err.details).toEqual({ handle: 'cat.png', modality: 'image', assetIds: ['owner', 'mid'] })
    const [mid] = (await s.listContext('chat1', { includeNonReferenceable: true })).filter((r) => r.assetId === 'mid')
    expect(mid.referenceable).toBe(false)
    expect(mid.handle).toBeUndefined()
  })
})
