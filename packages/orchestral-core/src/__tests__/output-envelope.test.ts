// `cost` on the shared envelopes is nullable on purpose: null = "the adapter
// did not report a cost", which is a different fact from 0 = "free". The
// schema must accept null, and must still reject the two values an adapter
// might reach for instead — a negative sentinel and leaving the field out.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { dispatchEnvelopeShape, metaEnvelopeShape } from '../output-envelope'

describe('envelope cost', () => {
  it('accepts null, rejects a negative sentinel and an omitted field', () => {
    const dispatch = z.object(dispatchEnvelopeShape)
    const base = { latencyMs: 1, model: 'p:m', provider: 'p' }
    expect(dispatch.safeParse({ ...base, cost: null }).success).toBe(true)
    expect(dispatch.safeParse({ ...base, cost: 0 }).success).toBe(true)
    expect(dispatch.safeParse({ ...base, cost: -1 }).success).toBe(false)
    expect(dispatch.safeParse({ ...base, cost: undefined }).success).toBe(false)
    expect(dispatch.safeParse(base).success).toBe(false)

    const meta = z.object(metaEnvelopeShape)
    expect(meta.safeParse({ latencyMs: 1, cost: null }).success).toBe(true)
    expect(meta.safeParse({ latencyMs: 1, cost: -1 }).success).toBe(false)
    expect(meta.safeParse({ latencyMs: 1 }).success).toBe(false)
  })
})
