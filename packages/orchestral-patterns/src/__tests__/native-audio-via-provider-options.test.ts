// Regression test for the native-audio variant deletion.
//
// native-audio used to be a Variant on text-to-video with
// `modelTags: ['native-audio-video']`. The variant axis was then
// deleted; the same capability is expressed by the LLM filling FLAT
// `providerOptions.{generateAudio|audio|sound}` per the top-1 resolved
// video model's typed schema. This test exercises the post-deletion path at
// this package's dispatch boundary (find_pattern → resolveDispatchTarget)
// only. A host's own adapter chain down to its provider SDK needs its own
// integration coverage: these tests all pass while the wire past this
// boundary is broken.
//
// SHAPE: the LLM sees FLAT single-provider sub-schema
// (no provider-name wrapper, `additionalProperties: false` declared). Host
// wraps with `providerOptionsKeyFor(providerName)` at the worker layer
// before forwarding to ai-sdk. This file pins the FLAT contract at the
// dispatch boundary — earlier versions of this test asserted a nested
// `providerOptions.bytedance.{...}` shape, which contradicted the derived
// schema and only "passed" because `.passthrough()` silently transported
// the wrong shape through.
//
//   1. dispatch_pattern accepts `{pattern_id: 'text-to-video', input: {prompt,
//      providerOptions: {generateAudio: true}}}` without a variant_id field
//      (which no longer exists on DispatchPatternInputSchema)
//   2. find_pattern's derived input schema for text-to-video (with a
//      bytedance/vertex/alibaba/kling model resolved) surfaces the
//      provider-specific audio flag in FLAT `providerOptions` typed schema
//      so the LLM can fill it from generateObject without guessing
//
// One assertion per video provider since each spells the flag differently
// (host resolution decides which key surfaces in derived schema):
//   - bytedance: generateAudio
//   - vertex:    generateAudio
//   - alibaba:   audio
//   - kling:     sound

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  deriveLlmFacingInputSchema,
  resolveDispatchTarget,
  isDispatchError,
  DispatchPatternInputSchema,
  PatternRegistry,
  type Pattern,
} from '@orchestral/core'
import { handleFindPattern, PatternSearchIndex } from '@orchestral/discovery'
import { createTextToVideoPattern } from '../index'

function freshIndex(): {
  index: PatternSearchIndex
  registry: PatternRegistry
} {
  const registry = new PatternRegistry()
  registry.add(createTextToVideoPattern() as unknown as Pattern)
  return { index: new PatternSearchIndex(registry), registry }
}

describe('native-audio via providerOptions (no variant)', () => {
  it('DispatchPatternInputSchema silently strips variant_id at the top level (Variant axis deleted)', () => {
    // Note the title says "silently strips," NOT "rejects" — the schema does
    // not reject extra keys at the wrapper level (zod's default behavior is
    // strict-strip, not strict-fail). The runtime contract is: nothing
    // downstream of resolveDispatchTarget sees `variant_id`.
    const parsed = DispatchPatternInputSchema.safeParse({
      pattern_id: 'text-to-video',
      variant_id: 'native-audio', // ← extra key, silently stripped by zod
      input: { prompt: 'cinematic shot' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('variant_id' in parsed.data).toBe(false)
    }
  })

  it('resolveDispatchTarget accepts text-to-video with FLAT providerOptions.generateAudio (bytedance/vertex spelling)', () => {
    const { registry } = freshIndex()
    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'text-to-video',
        input: {
          prompt: 'cinematic dolly shot of a neon market street at night',
          providerOptions: { generateAudio: true },
        },
      },
      'chat-turn',
    )
    expect(isDispatchError(result)).toBe(false)
    if (!isDispatchError(result)) {
      expect(result.pattern.id).toBe('text-to-video')
      const parsed = result.parsedInput as {
        prompt: string
        providerOptions?: { generateAudio?: boolean }
      }
      expect(parsed.prompt).toContain('cinematic')
      expect(parsed.providerOptions?.generateAudio).toBe(true)
    }
  })

  it('resolveDispatchTarget accepts text-to-video with FLAT providerOptions.audio (alibaba spelling)', () => {
    const { registry } = freshIndex()
    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'text-to-video',
        input: {
          prompt: 'a quiet rainy alley',
          providerOptions: { audio: true },
        },
      },
      'chat-turn',
    )
    expect(isDispatchError(result)).toBe(false)
    if (!isDispatchError(result)) {
      const parsed = result.parsedInput as {
        providerOptions?: { audio?: boolean }
      }
      expect(parsed.providerOptions?.audio).toBe(true)
    }
  })

  it('resolveDispatchTarget accepts text-to-video with FLAT providerOptions.sound (kling spelling)', () => {
    // kling spells the joint-audio flag as `sound` (vs bytedance/vertex's
    // `generateAudio` and alibaba's `audio`). Host resolution decides which
    // key surfaces in derived schema based on the resolved model's typed
    // providerOptions shape. This test pins the kling spelling so a future
    // schema patch can't accidentally rename it without flipping a test.
    const { registry } = freshIndex()
    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'text-to-video',
        input: {
          prompt: 'a kite festival at dusk',
          providerOptions: { sound: true },
        },
      },
      'chat-turn',
    )
    expect(isDispatchError(result)).toBe(false)
    if (!isDispatchError(result)) {
      const parsed = result.parsedInput as {
        providerOptions?: { sound?: boolean }
      }
      expect(parsed.providerOptions?.sound).toBe(true)
    }
  })

  it('find_pattern derived schema lifts bytedance.generateAudio into typed providerOptions', () => {
    const { index } = freshIndex()
    // Simulate a curated bytedance schema being resolved as the top
    // candidate. In production this comes from the host's
    // deriveProviderOptionsZod closure consulting the ModelCapability
    // registry; here we inline a minimal shape.
    const bytedanceShape = z.object({
      generateAudio: z.boolean().optional(),
      cameraFixed: z.boolean().optional(),
    })

    const result = handleFindPattern(
      index,
      { query: 'select:text-to-video' },
      {
        // The closure returns the MERGED LLM-facing schema
        // (host invokes the lift). Neither bytedance field is liftable, so both
        // land under the typed `providerOptions` object; find_pattern z2js-es it.
        deriveProviderOptionsZod: (id, baseSchema) =>
          id === 'text-to-video'
            ? deriveLlmFacingInputSchema(baseSchema, bytedanceShape)
            : undefined,
      },
    )
    const match = result.matches.find((m) => m.patternId === 'text-to-video')
    expect(match).toBeDefined()
    const inputSchema = match!.primary.inputSchema as {
      properties?: {
        providerOptions?: {
          properties?: Record<string, unknown>
        }
      }
    }
    // LLM sees the typed providerOptions sub-schema with the
    // provider's raw field names — no more variant_id indirection.
    const poProps = inputSchema.properties?.providerOptions?.properties
    expect(poProps).toBeDefined()
    expect(poProps).toHaveProperty('generateAudio')
    expect(poProps).toHaveProperty('cameraFixed')
  })
})
