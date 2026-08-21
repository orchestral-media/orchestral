import { describe, expect, it } from 'vitest'

import { PatternRegistry, type Pattern } from '@orchestral/core'
import {
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
} from '../index'

describe('PatternRegistry.getEntry', () => {
  // Variant-related getEntry assertions were removed. RegistryEntry no
  // longer carries `variants`; `attachVariant` was deleted from the registry
  // surface. dispatch_pattern's `variant_id` field was also removed from
  // DispatchPatternInputSchema. The remaining alternatives-attach contract
  // is preserved and exercised below.

  it('register() with the alternatives sugar attaches identically to add()', () => {
    // The trap this pins: register() is public and documented as retained;
    // silently dropping a factory's declared fallbacks (while the return
    // type hides the field from tsc) would leave dispatch with no
    // degradation chain and zero warnings.
    const registry = new PatternRegistry()
    registry.register(
      createImageToImagePattern({
        alternatives: [
          {
            id: 'fallback-via-caption',
            description: 'fallback',
            appliesWhen: { kind: 'always' },
            via: {
              patternId: 'meta_image-to-image-via-caption',
              mapInput: () => ({ editPrompt: 'x', tier: 'preview' }),
              mapOutput: () => ({
                modality: 'image' as const,
                assets: [],
                cost: 0,
                latencyMs: 0,
                model: 'mock:any',
                provider: 'mock',
              }),
            },
          },
        ],
      }),
    )
    const entry = registry.getEntry('image-to-image')
    expect(entry?.alternatives.map((a) => a.id)).toEqual(['fallback-via-caption'])
    // The stored Pattern does not carry the sugar field.
    expect(
      (entry?.pattern as { alternatives?: unknown }).alternatives,
    ).toBeUndefined()
  })

  it('returns alternatives declared through add()', () => {
    const registry = new PatternRegistry()
    registry.add(
      createImageToImagePattern({
        alternatives: [
          {
            id: 'fallback-via-caption',
            description: 'fallback',
            appliesWhen: { kind: 'always' },
            via: {
              patternId: 'meta_image-to-image-via-caption',
              mapInput: () => ({ editPrompt: 'x', tier: 'preview' }),
              mapOutput: () => ({
                modality: 'image' as const,
                assets: [],
                cost: 0,
                latencyMs: 0,
                model: 'mock:any',
                provider: 'mock',
              }),
            },
          },
        ],
      }) as unknown as Pattern,
    )
    registry.add(createImageToImageViaCaptionPattern() as unknown as Pattern)

    expect(registry.getEntry('image-to-image')?.alternatives.map((a) => a.id)).toEqual([
      'fallback-via-caption',
    ])
  })
})
