// mintNext — the one handle-minting rule, plus the proof that both ledgers mint by it.
import { describe, expect, it } from 'vitest'

import { buildAssetIndex, mintNext } from '../asset-index'
import type { AssetEvent } from '../asset-index.types'
import { InMemoryAssetStore } from '../asset-store'

function thrown(fn: () => unknown): Error & { code?: string; details?: unknown } {
  try {
    fn()
  } catch (e) {
    return e as Error & { code?: string; details?: unknown }
  }
  throw new Error('expected the mint to be refused')
}

describe('mintNext', () => {
  it('an unannotated mint takes the next slot and advances the count', () => {
    expect(mintNext({ priorCount: 0, modality: 'image', assetId: 'a1', supplied: undefined })).toEqual({
      handle: 'image_1',
      seq: 1,
      nextCount: 1,
    })
    expect(mintNext({ priorCount: 2, modality: 'video', assetId: 'v3', supplied: undefined })).toEqual({
      handle: 'video_3',
      seq: 3,
      nextCount: 3,
    })
  })

  it('a replayed mint pins its own ordinal and pulls the count up to it', () => {
    expect(mintNext({ priorCount: 0, modality: 'image', assetId: 'A', supplied: 'image_2' })).toEqual({
      handle: 'image_2',
      seq: 2,
      nextCount: 2,
    })
  })

  it('a replay below the high-water mark never pulls it back down', () => {
    expect(mintNext({ priorCount: 5, modality: 'image', assetId: 'A', supplied: 'image_2' })).toEqual({
      handle: 'image_2',
      seq: 2,
      nextCount: 5,
    })
  })

  it('an opaque host name takes the next slot exactly as an unannotated mint would', () => {
    expect(mintNext({ priorCount: 0, modality: 'image', assetId: 'A', supplied: 'hero-shot' })).toEqual({
      handle: 'hero-shot',
      seq: 1,
      nextCount: 1,
    })
    // another modality's mint is an opaque name here, not an ordinal
    expect(mintNext({ priorCount: 0, modality: 'image', assetId: 'A', supplied: 'video_3' })).toEqual({
      handle: 'video_3',
      seq: 1,
      nextCount: 1,
    })
  })

  it('a handle bound to a DIFFERENT asset is refused, in binding order', () => {
    const err = thrown(() =>
      mintNext({
        priorCount: 1,
        modality: 'image',
        assetId: 'B',
        supplied: 'image_1',
        boundAssetIdOf: () => 'A',
      }),
    )
    expect(err.message.startsWith('HANDLE_COLLISION:')).toBe(true)
    expect(err.code).toBe('HANDLE_COLLISION')
    expect(err.details).toEqual({ handle: 'image_1', modality: 'image', assetIds: ['A', 'B'] })
  })

  it('the same asset re-claiming its own handle is a replay, not a collision', () => {
    expect(
      mintNext({
        priorCount: 1,
        modality: 'image',
        assetId: 'A',
        supplied: 'image_1',
        boundAssetIdOf: () => 'A',
      }),
    ).toEqual({ handle: 'image_1', seq: 1, nextCount: 1 })
  })
})

// The two ledgers that mint handles — buildAssetIndex (replaying a host's
// persisted records) and InMemoryAssetStore (the live write path) — must agree
// handle-for-handle and seq-for-seq, because a durable host replays the
// second's records through the first. This table is that assertion, and it is
// what keeps the extraction below honest.
const SCENARIOS: ReadonlyArray<{
  name: string
  supplied: ReadonlyArray<string | undefined>
  expected: ReadonlyArray<readonly [string, number]>
}> = [
  {
    name: 'three fresh mints',
    supplied: [undefined, undefined, undefined],
    expected: [
      ['image_1', 1],
      ['image_2', 2],
      ['image_3', 3],
    ],
  },
  {
    name: 'a replayed mint, then a fresh one past it',
    supplied: ['image_2', undefined],
    expected: [
      ['image_2', 2],
      ['image_3', 3],
    ],
  },
  {
    name: 'an opaque upload name, then a fresh mint',
    supplied: ['hero-shot', undefined],
    expected: [
      ['hero-shot', 1],
      ['image_2', 2],
    ],
  },
  {
    name: 'a high replay, a low replay, then a fresh mint past the high-water mark',
    supplied: ['image_5', 'image_3', undefined],
    expected: [
      ['image_5', 5],
      ['image_3', 3],
      ['image_6', 6],
    ],
  },
]

describe('buildAssetIndex and InMemoryAssetStore mint by the same rule', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: index and store agree`, async () => {
      const events: AssetEvent[] = sc.supplied.map((h, i) => ({
        kind: 'asset',
        orderHint: i + 1,
        annotation: { assetId: `a${i}`, modality: 'image', ...(h !== undefined ? { handle: h } : {}) },
      }))
      const fromIndex = buildAssetIndex(events)
        .all()
        .map((e) => [e.handle, e.sequence])

      const store = new InMemoryAssetStore()
      const fromStore: Array<[string, number]> = []
      for (const [i, h] of sc.supplied.entries()) {
        const rec = await store.record('chat1', {
          assetId: `a${i}`,
          modality: 'image',
          origin: 'tool-output',
          ...(h !== undefined ? { handle: h } : {}),
        })
        fromStore.push([rec.handle as string, rec.seq as number])
      }

      expect(fromIndex).toEqual(sc.expected.map((p) => [...p]))
      expect(fromStore).toEqual(sc.expected.map((p) => [...p]))
    })
  }

  it('both refuse the same rebind with the same HANDLE_COLLISION payload', async () => {
    const events: AssetEvent[] = [
      { kind: 'asset', orderHint: 1, annotation: { assetId: 'a1', modality: 'image' } },
      { kind: 'asset', orderHint: 2, annotation: { assetId: 'a2', modality: 'image' } },
      { kind: 'asset', orderHint: 3, annotation: { assetId: 'c', modality: 'image', handle: 'image_1' } },
    ]
    const fromIndex = thrown(() => buildAssetIndex(events))

    const store = new InMemoryAssetStore()
    await store.record('chat1', { assetId: 'a1', modality: 'image', origin: 'tool-output' })
    await store.record('chat1', { assetId: 'a2', modality: 'image', origin: 'tool-output' })
    let fromStore: Error & { code?: string; details?: unknown } = new Error('unset')
    try {
      await store.record('chat1', { assetId: 'c', modality: 'image', origin: 'upload', handle: 'image_1' })
      throw new Error('expected the record to reject')
    } catch (e) {
      fromStore = e as Error & { code?: string; details?: unknown }
    }

    expect(fromIndex.code).toBe('HANDLE_COLLISION')
    expect(fromStore.code).toBe('HANDLE_COLLISION')
    expect(fromIndex.details).toEqual({ handle: 'image_1', modality: 'image', assetIds: ['a1', 'c'] })
    expect(fromStore.details).toEqual(fromIndex.details)
    expect(fromStore.message).toBe(fromIndex.message)
  })
})
