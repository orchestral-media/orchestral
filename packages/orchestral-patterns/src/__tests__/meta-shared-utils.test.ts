import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import {
  firstAssetId,
  parseJsonWithSchema,
  styleTag,
  toJsonSchemaCached,
} from '../meta/_shared/meta-utils'

describe('meta/_shared/meta-utils', () => {
  describe('toJsonSchemaCached', () => {
    it('emits draft-2020-12 JSON Schema for a Zod object', () => {
      const schema = z.object({ prompt: z.string() })
      const json = toJsonSchemaCached(schema) as Record<string, unknown>
      expect(json).toMatchObject({ type: 'object' })
      expect(json.$schema).toContain('2020-12')
    })
  })

  describe('firstAssetId', () => {
    it('returns the first asset id', () => {
      const out = { assets: [{ assetId: 'a1' }, { assetId: 'a2' }] }
      expect(firstAssetId(out, 'pattern: step')).toBe('a1')
    })

    it('accepts a ReadonlyArray of assets', () => {
      const out: { assets?: ReadonlyArray<{ assetId: string }> } = {
        assets: [{ assetId: 'only' }],
      }
      expect(firstAssetId(out, 'pattern: step')).toBe('only')
    })

    it('throws the labeled error when assets is empty', () => {
      expect(() => firstAssetId({ assets: [] }, 'product-ad-short: image-to-video')).toThrow(
        'product-ad-short: image-to-video produced no asset',
      )
    })

    it('throws the labeled error when assets is undefined', () => {
      expect(() => firstAssetId({}, 'ugc-testimonial: text-to-speech')).toThrow(
        'ugc-testimonial: text-to-speech produced no asset',
      )
    })
  })

  describe('styleTag', () => {
    it('renders the style as an XML-tagged block', () => {
      expect(styleTag('cinematic')).toBe('\n<STYLE>\ncinematic\n</STYLE>')
    })

    it('returns the empty string when no style was given', () => {
      expect(styleTag(undefined)).toBe('')
    })
  })

  describe('parseJsonWithSchema', () => {
    const Schema = z.object({ prompts: z.array(z.string()).min(1) })

    it('parses valid JSON and validates against the schema', () => {
      const parsed = parseJsonWithSchema('{"prompts":["a","b"]}', Schema, 'product-ad-short')
      expect(parsed.prompts).toEqual(['a', 'b'])
    })

    it('throws the labeled error on malformed JSON', () => {
      expect(() => parseJsonWithSchema('not json{', Schema, 'product-ad-short')).toThrow(
        'product-ad-short: text-generation did not return valid JSON',
      )
    })

    it('lets schema violations propagate from Zod (not the labeled JSON error)', () => {
      // Valid JSON, but fails the schema — Zod throws, NOT the "did not return
      // valid JSON" guard.
      expect(() => parseJsonWithSchema('{"prompts":[]}', Schema, 'product-ad-short')).toThrow(
        z.ZodError,
      )
    })
  })
})
