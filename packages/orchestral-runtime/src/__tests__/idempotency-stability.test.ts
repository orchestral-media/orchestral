import { describe, expect, it } from 'vitest'

import { deriveIdempotencyKey, type DeriveIdempotencyKeyInput } from '../idempotency'

// Runtime-freeze gate. The idempotency hash is persisted (it keys
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

  // The Variant axis was removed. `variantId` is no longer part of
  // DeriveIdempotencyKeyInput, so it cannot be folded into the canonical
  // payload. Two requests that historically differed only on variantId now
  // produce the same key. The type-level guard below documents that the field
  // is gone — re-introducing it as a typed field would surface here.
  it('variantId is not part of the key — the Variant axis was removed', () => {
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

  // The second pinned hash. `stepKey` is the name-based identity a step opts
  // into with StepOptions.identity:'id'; it is spread in conditionally, so it
  // gets its own freeze gate rather than perturbing the one above.
  it('hash is stable for a fixed input carrying a stepKey', () => {
    const key = deriveIdempotencyKey({
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
      stepKey: 'render',
    })
    expect(key).toMatchInlineSnapshot(`"8996641afd40ff90e2b4f05d73cda57370225e1435d658df532e471fb35bb4bd"`)
  })

  // The whole point of the conditional spread. An explicit `undefined` must be
  // indistinguishable from the field never having been written, or every
  // caller that threads `spec.stepKey` straight through — which is what the
  // runtime does — would move every key it touches.
  it('an absent stepKey and an explicit undefined hash identically', () => {
    const absent: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
    }
    const explicitUndefined: DeriveIdempotencyKeyInput = {
      ...absent,
      stepKey: undefined,
    }
    expect(deriveIdempotencyKey(explicitUndefined)).toBe(
      deriveIdempotencyKey(absent),
    )
    // And it is still the pre-stepKey digest — no stored row moved.
    expect(deriveIdempotencyKey(absent)).toBe(
      '4aaca9602308759a19fa826fc60c3488830dd2ab6269833f2095b52042fb788a',
    )
  })

  it('a present stepKey changes the key, and two stepKeys differ from each other', () => {
    const base: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepIndex: 0,
    }
    const withoutKey = deriveIdempotencyKey(base)
    const render = deriveIdempotencyKey({ ...base, stepKey: 'render' })
    const upscale = deriveIdempotencyKey({ ...base, stepKey: 'upscale' })

    // Opting in is itself a different unit of work: a positional row and a
    // name-keyed row for the same call must not dedupe onto each other.
    expect(render).not.toBe(withoutKey)
    // Two named steps with identical inputs are two steps — which is exactly
    // what lets a plan write three identical `take-*` steps.
    expect(render).not.toBe(upscale)
  })

  // The insert-a-step property, at the level of the hash: a name-keyed step
  // does not move when the positional index around it does. `stepIndex` is
  // still in the payload (as the constant 0) — the two must never both vary.
  it('a stepKey-carrying input is unaffected by the step index it replaced', () => {
    const named = (stepIndex: number | undefined) =>
      deriveIdempotencyKey({
        patternId: 'text-to-image',
        input: { prompt: 'a red bicycle' },
        sessionId: 'sess-1',
        stepIndex,
        stepKey: 'render',
      })
    // ctx.step omits stepIndex under identity:'id', so this is the real call;
    // the derivation's `?? 0` makes it the same key as an explicit 0.
    expect(named(undefined)).toBe(named(0))
  })
})
