import { describe, expect, it } from 'vitest'

import { deriveIdempotencyKey, type DeriveIdempotencyKeyInput } from '../idempotency'

// Phase 4 runtime-freeze gate. The idempotency hash is persisted (it keys
// dedup decisions and job rows), so the canonical serialisation + sha256 must
// stay byte-stable across releases. Any change to the canonicaliser, the
// hashed field set, or the digest algorithm flips the pinned hash below and
// trips this test — a deliberate decision is then required to re-pin it.
describe('deriveIdempotencyKey stability', () => {
  it('hash is stable for a fixed input', () => {
    const key = deriveIdempotencyKey({
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
    })
    expect(key).toMatchInlineSnapshot(`"4aaca9602308759a19fa826fc60c3488830dd2ab6269833f2095b52042fb788a"`)
  })

  // ADR-024: the Variant axis was removed. `variantId` is no longer part of
  // DeriveIdempotencyKeyInput, so it cannot be folded into the canonical
  // payload. Two requests that historically differed only on variantId now
  // produce the same key. The type-level guard below documents that the field
  // is gone — re-introducing it as a typed field would surface here.
  it('variantId is no longer part of the key (ADR-024 removal)', () => {
    const withGhostField: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
      // @ts-expect-error — variantId is not a member of DeriveIdempotencyKeyInput.
      variantId: 'fast',
    }

    const canonical: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
    }

    // The canonicaliser only walks the declared fields, so the stray
    // variantId does not perturb the digest: dedup is variant-blind.
    expect(deriveIdempotencyKey(withGhostField)).toBe(
      deriveIdempotencyKey(canonical),
    )
  })
})
