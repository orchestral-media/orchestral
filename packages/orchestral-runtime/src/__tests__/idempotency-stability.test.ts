import { describe, expect, it } from 'vitest'

import { deriveIdempotencyKey, type DeriveIdempotencyKeyInput } from '../idempotency'

// Runtime-freeze gate. The idempotency hash is persisted (it keys
// dedup decisions and job rows), so the canonical serialisation + sha256 must
// stay byte-stable across releases. Any change to the canonicaliser, the
// hashed field set, or the digest algorithm flips the pinned hash below and
// trips this test — a deliberate decision is then required to re-pin it.
describe('deriveIdempotencyKey stability', () => {
  // A host's direct submit: no step made it, so it carries no stepKey.
  it('hash is stable for a fixed input', () => {
    const key = deriveIdempotencyKey({
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
    })
    expect(key).toMatchInlineSnapshot(`"648e63fee82ac1151e79d7bfd55c71616862cc59516aca1cb9e7e1d376d14431"`)
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
      // @ts-expect-error — variantId is not a member of DeriveIdempotencyKeyInput.
      variantId: 'fast',
    }

    const canonical: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
    }

    // The canonicaliser only walks the declared fields, so the stray
    // variantId does not perturb the digest: dedup is variant-blind.
    expect(deriveIdempotencyKey(withGhostField)).toBe(
      deriveIdempotencyKey(canonical),
    )
  })

  // A root step named `render`: the step's path is its name.
  it('hash is stable for a fixed input carrying a stepKey', () => {
    const key = deriveIdempotencyKey({
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepKey: 'render',
    })
    expect(key).toMatchInlineSnapshot(`"de7c3d6e46c94a897624f1dbb6c8467b7e7f04c90494dfab3e3c174464039a93"`)
  })

  // An unnamed step one level down: the launching step's id, then the
  // pattern and its ordinal among that compose's unnamed calls to it.
  it('hash is stable for a nested step path', () => {
    const key = deriveIdempotencyKey({
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepKey: 'panel-0/text-to-image#0',
    })
    expect(key).toMatchInlineSnapshot(`"1226ffe090a5d5283bf5565bc3ddb688ccaf475f58b55135a7a5fc0f623f3d44"`)
  })

  // An explicit `undefined` must be indistinguishable from the field never
  // having been written: the runtime threads `spec.stepKey` straight through,
  // and a host's direct submit has none.
  it('an absent stepKey and an explicit undefined hash identically', () => {
    const absent: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
    }
    const explicitUndefined: DeriveIdempotencyKeyInput = {
      ...absent,
      stepKey: undefined,
    }
    expect(deriveIdempotencyKey(explicitUndefined)).toBe(
      deriveIdempotencyKey(absent),
    )
    // An absent stepKey hashes as null: it is the host-direct pin above.
    expect(deriveIdempotencyKey(absent)).toBe(
      '648e63fee82ac1151e79d7bfd55c71616862cc59516aca1cb9e7e1d376d14431',
    )
  })

  it('a present stepKey changes the key, and two stepKeys differ from each other', () => {
    const base: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
    }
    const withoutKey = deriveIdempotencyKey(base)
    const render = deriveIdempotencyKey({ ...base, stepKey: 'render' })
    const upscale = deriveIdempotencyKey({ ...base, stepKey: 'upscale' })

    // A host-direct row and a step's row never dedupe onto each other.
    expect(render).not.toBe(withoutKey)
    // Two named steps with identical inputs are two steps — which is exactly
    // what lets a plan write three identical `take-*` steps.
    expect(render).not.toBe(upscale)
  })

  // A step is keyed by where it sits, never by when it was called: the field
  // that carried the call-time position is gone from the input, and a stray
  // one is not hashed.
  it('stepIndex is not part of the key and is not a member of the input', () => {
    const withStrayIndex: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepKey: 'render',
      // @ts-expect-error — a step is keyed by its path (stepKey), never by a position
      stepIndex: 0,
    }
    const keyed: DeriveIdempotencyKeyInput = {
      patternId: 'text-to-image',
      input: { prompt: 'a red bicycle' },
      sessionId: 'sess-1',
      stepKey: 'render',
    }
    expect(deriveIdempotencyKey(withStrayIndex)).toBe(
      deriveIdempotencyKey(keyed),
    )
  })
})
