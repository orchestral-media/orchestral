import { describe, expect, it } from 'vitest'

import {
  deriveIdempotencyKey,
  IdempotencyNotSerialisableError,
} from '../idempotency'

const base = {
  patternId: 'text-to-image' as const,
}

describe('deriveIdempotencyKey', () => {
  it('returns the same hash for identical inputs', () => {
    const a = deriveIdempotencyKey({ ...base, input: { prompt: 'cat' } })
    const b = deriveIdempotencyKey({ ...base, input: { prompt: 'cat' } })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })

  it('is insensitive to object key order', () => {
    const a = deriveIdempotencyKey({
      ...base,
      input: { a: 1, b: 2, c: { x: 1, y: 2 } },
    })
    const b = deriveIdempotencyKey({
      ...base,
      input: { c: { y: 2, x: 1 }, b: 2, a: 1 },
    })
    expect(a).toBe(b)
  })

  it('differs when input differs', () => {
    const a = deriveIdempotencyKey({ ...base, input: { prompt: 'cat' } })
    const b = deriveIdempotencyKey({ ...base, input: { prompt: 'dog' } })
    expect(a).not.toBe(b)
  })

  it('separates step indices', () => {
    const a = deriveIdempotencyKey({ ...base, input: { x: 1 }, stepIndex: 0 })
    const b = deriveIdempotencyKey({ ...base, input: { x: 1 }, stepIndex: 1 })
    expect(a).not.toBe(b)
  })

  it('separates sessions', () => {
    const a = deriveIdempotencyKey({ ...base, input: { x: 1 }, sessionId: 's1' })
    const b = deriveIdempotencyKey({ ...base, input: { x: 1 }, sessionId: 's2' })
    expect(a).not.toBe(b)
  })

  it('treats missing assets as semantically null', () => {
    const a = deriveIdempotencyKey({ ...base, input: { x: 1 } })
    const b = deriveIdempotencyKey({ ...base, input: { x: 1 }, assets: undefined })
    expect(a).toBe(b)
  })

  it('differs when resolved assets differ', () => {
    const a = deriveIdempotencyKey({
      ...base,
      input: { x: 1 },
      assets: [{ slot: 'source', assetId: 'a1', modality: 'image' }],
    })
    const b = deriveIdempotencyKey({
      ...base,
      input: { x: 1 },
      assets: [{ slot: 'source', assetId: 'a2', modality: 'image' }],
    })
    expect(a).not.toBe(b)
  })

  it('rejects non-finite numbers', () => {
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { x: Number.NaN } }),
    ).toThrow(IdempotencyNotSerialisableError)
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { x: Number.POSITIVE_INFINITY } }),
    ).toThrow(IdempotencyNotSerialisableError)
  })

  it('rejects bigint, symbol, function', () => {
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { x: 1n } }),
    ).toThrow(IdempotencyNotSerialisableError)
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { x: Symbol('s') } }),
    ).toThrow(IdempotencyNotSerialisableError)
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { x: () => 1 } }),
    ).toThrow(IdempotencyNotSerialisableError)
  })

  it('rejects non-plain objects (Date / Map / Set / Buffer)', () => {
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { d: new Date() } }),
    ).toThrow(IdempotencyNotSerialisableError)
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { m: new Map() } }),
    ).toThrow(IdempotencyNotSerialisableError)
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { s: new Set() } }),
    ).toThrow(IdempotencyNotSerialisableError)
  })

  it('rejects undefined inside arrays', () => {
    expect(() =>
      deriveIdempotencyKey({ ...base, input: { xs: [1, undefined, 3] } }),
    ).toThrow(IdempotencyNotSerialisableError)
  })

  it('drops undefined object properties (matches JSON semantics)', () => {
    const a = deriveIdempotencyKey({ ...base, input: { a: 1, b: undefined } })
    const b = deriveIdempotencyKey({ ...base, input: { a: 1 } })
    expect(a).toBe(b)
  })
})
