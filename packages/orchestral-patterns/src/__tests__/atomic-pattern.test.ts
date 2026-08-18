import { describe, expect, it } from 'vitest'

import {
  createTextToImagePattern,
  createImageToImagePattern,
  createImageToTextPattern,
} from '../index'

// First-party atomic factories' exposureMode declarations. The AtomicPattern
// CLASS invariants (ctor primary-required guard, Init→field threading) are a
// @orchestral/core skeleton concern and are tested there; here we only pin the
// catalog-facing exposureMode values the factories ship with.

describe('first-party atomic exposureMode', () => {
  it('generative atomics opt into always-load (one-step direct dispatch)', () => {
    expect(createTextToImagePattern().exposureMode).toBe('always-load')
    expect(createImageToImagePattern().exposureMode).toBe('always-load')
  })

  it('understanding-class atomics stay deferred (handled by the main model)', () => {
    expect(createImageToTextPattern().exposureMode).toBeUndefined()
  })
})
