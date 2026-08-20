// The adapter-contract gate, at the unit level: which declarations pass, which
// are refused, and what the refusal carries. The dispatch-path half of the
// claim (the guard actually runs before `ModelCapability.call`) is pinned in
// @orchestral/runtime's model-spec-version-gate.test.ts.
import { describe, expect, it } from 'vitest'

import type { ModelCapability, ModelSpecVersion } from '../index'
import {
  assertSupportedModelSpecVersion,
  MODEL_SPEC_VERSION,
  ModelSpecVersionUnsupportedError,
  SUPPORTED_MODEL_SPEC_VERSIONS,
} from '../index'

/** Only the three fields the guard reads. */
function envelope(specificationVersion?: string): ModelCapability {
  return {
    provider: 'fake',
    modelId: 'm',
    ...(specificationVersion === undefined ? {} : { specificationVersion }),
  } as unknown as ModelCapability
}

describe('ModelCapability specificationVersion', () => {
  // Bumping these is a deliberate contract change, not a refactor.
  it('pins the advertised contract generation', () => {
    expect(MODEL_SPEC_VERSION).toBe('v1')
    expect(SUPPORTED_MODEL_SPEC_VERSIONS).toEqual(['v1'])
    // Whatever a new adapter is told to declare must be executable.
    expect(SUPPORTED_MODEL_SPEC_VERSIONS).toContain(MODEL_SPEC_VERSION)
  })

  it('accepts an adapter that declares nothing (read as v1)', () => {
    expect(() => assertSupportedModelSpecVersion(envelope())).not.toThrow()
  })

  it('accepts an explicit supported version', () => {
    const declared: ModelSpecVersion = MODEL_SPEC_VERSION
    expect(() =>
      assertSupportedModelSpecVersion({
        provider: 'fake',
        modelId: 'm',
        specificationVersion: declared,
      }),
    ).not.toThrow()
  })

  // 'v2' is not expressible in `ModelSpecVersion` today — that is the
  // compile-time half of the protection. The cast simulates the case the type
  // system cannot see: an adapter package compiled against a NEWER
  // @orchestral/core and handed to this build at wiring time.
  it('refuses a future version with a stable code and a readable diagnostic', () => {
    let thrown: unknown
    try {
      assertSupportedModelSpecVersion(envelope('v2'))
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ModelSpecVersionUnsupportedError)
    const err = thrown as ModelSpecVersionUnsupportedError
    expect(err.code).toBe('MODEL_SPEC_VERSION_UNSUPPORTED')
    expect(err.diagnostic).toEqual({
      model: 'fake:m',
      received: 'v2',
      supported: SUPPORTED_MODEL_SPEC_VERSIONS,
      hint: expect.stringContaining('Upgrade'),
    })
    // The message says what arrived and what this build can run.
    expect(err.message).toContain("'v2'")
    expect(err.message).toContain("'v1'")
    expect(err.message).toContain('fake:m')
  })

  // A JS host (or a hand-built record from a store) can put anything here;
  // only `undefined` means "not declared".
  it.each([
    { label: 'empty string', value: '' },
    { label: 'unknown label', value: 'latest' },
    { label: 'null', value: null },
    { label: 'number', value: 1 },
  ])('refuses a non-version declaration ($label)', ({ value }) => {
    expect(() =>
      assertSupportedModelSpecVersion(envelope(value as unknown as string)),
    ).toThrow(ModelSpecVersionUnsupportedError)
  })
})
