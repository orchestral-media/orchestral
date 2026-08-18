// derive-pattern-input.test.ts — ADR-012 §2.7 lift function coverage.
//
// Cases:
//   • undefined providerOptions → baseSchema unchanged (referential identity)
//   • providerOptions present but no LIFTABLE field → baseSchema unchanged
//   • Suno literal lift (n: z.literal(2))
//   • Vertex Imagen enum lift (aspectRatio: z.enum)
//   • Veo 3.1 range lift (duration: z.number().min(2).max(15))
//   • Veo 2 native batch lift (n: z.number().max(4))
//   • Multiple lifts in one model (n + duration + fps)
//   • Unmarked fields stay nested under providerOptions — a field is lifted iff
//     it carries LIFT_MARKER, regardless of name (negativePrompt etc.)
//   • LLM sees constraint via parse() — Suno z.literal(2) rejects n=3
//   • providerOptions field overrides base default (n: 1 → n: 2)

import { describe, expect, it } from 'vitest'
import { z, type ZodRawShape, type ZodTypeAny } from 'zod'

import {
  deriveLlmFacingInputSchema,
  LIFT_MARKER,
  ASSET_MARKER,
} from '../derive-pattern-input'

/**
 * Mirror the host `_liftable.ts` `markLiftable()` helper — OSS tests can't import
 * the host package, so we stamp the marker the same way the builders do.
 */
function markField<T extends ZodTypeAny>(s: T): T {
  Object.defineProperty(s, LIFT_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return s
}

/**
 * Mirror the host `_liftable.ts` `markHostAsset()` helper — stamps ASSET_MARKER
 * with the `{ fromSlot, format }` binding payload the host reads at dispatch.
 * OSS reads only the marker's presence (never its shape), so `format` is here
 * only to keep the fixture faithful to the real binding.
 */
function markAsset<T extends ZodTypeAny>(s: T, fromSlot: string): T {
  Object.defineProperty(s, ASSET_MARKER, {
    value: { fromSlot, format: 'rawBase64' },
    enumerable: false,
    configurable: true,
  })
  return s
}

// Mirrors text-to-image primary input(post-ADR-012)。Used as the base in
// most tests so we can see what the LLM-facing schema looks like before lift.
const baseT2iSchema = z.object({
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(8).default(1),
  size: z.string().optional(),
  aspectRatio: z.string().optional(),
  seed: z.number().int().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
})

const baseT2vSchema = z.object({
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(4).default(1),
  durationSeconds: z.number().min(1).max(25).default(5),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5', '3:4']).default('16:9'),
  resolution: z.enum(['480p', '720p', '1080p', '4k']).default('720p'),
  fps: z.number().int().min(8).max(60).default(24),
  seed: z.number().int().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
})

describe('deriveLlmFacingInputSchema', () => {
  describe('identity preservation', () => {
    it('returns baseSchema unchanged when providerOptions is undefined', () => {
      const result = deriveLlmFacingInputSchema(baseT2iSchema, undefined)
      expect(result).toBe(baseT2iSchema)
    })

    it('builds typed input.providerOptions even when providerOptions has no LIFTABLE field (v1.2 behavior)', () => {
      // v1.1 expectation:return baseSchema unchanged (referential identity).
      // v1.2 expectation:always replace input.providerOptions with typed
      // z.object(remaining) so LLM sees concrete field names instead of
      // z.record(z.unknown()) — see ADR-012 v1.2 §2.7.
      const providerOpts = z.object({
        negativePrompt: z.string().optional(),
        style: z.string().optional(),
      })
      const result = deriveLlmFacingInputSchema(baseT2iSchema, providerOpts)
      // Schema must be a new instance — typed providerOptions was injected.
      expect(result).not.toBe(baseT2iSchema)
      // The new input.providerOptions accepts the typed fields.
      const ok = result.safeParse({
        prompt: 'a song',
        n: 1,
        providerOptions: { negativePrompt: 'blurry', style: 'cinematic' },
      })
      expect(ok.success).toBe(true)
    })
  })

  describe('Suno literal lift (D5 example)', () => {
    it('lifts n: z.literal(2) so LLM sees fixed 2 outputs', () => {
      const sunoOpts = z.object({
        n: markField(z.literal(2)),
        lyrics: z.string().optional(),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, sunoOpts)
      // The lifted schema rejects n=3 because n is now z.literal(2)
      const result = lifted.safeParse({ prompt: 'a song', n: 3 })
      expect(result.success).toBe(false)
    })

    it('accepts n=2 after Suno lift', () => {
      const sunoOpts = z.object({ n: markField(z.literal(2)) })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, sunoOpts)
      const result = lifted.safeParse({ prompt: 'a song', n: 2 })
      expect(result.success).toBe(true)
    })
  })

  describe('Vertex Imagen enum lift', () => {
    it('lifts aspectRatio enum so LLM sees only allowed values', () => {
      const vertexOpts = z.object({
        aspectRatio: markField(z.enum(['1:1', '3:4', '4:3', '9:16', '16:9'])),
        negativePrompt: z.string().optional(),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, vertexOpts)
      // 21:9 is not in the enum → rejected
      const result = lifted.safeParse({
        prompt: 'a landscape',
        aspectRatio: '21:9',
      })
      expect(result.success).toBe(false)
    })

    it('accepts allowed enum value after lift', () => {
      const vertexOpts = z.object({
        aspectRatio: markField(z.enum(['1:1', '3:4', '4:3', '9:16', '16:9'])),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, vertexOpts)
      const result = lifted.safeParse({
        prompt: 'a landscape',
        aspectRatio: '16:9',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('Veo 3.1 range lift (video)', () => {
    it('lifts duration constraint min(2).max(15)', () => {
      const veoOpts = z.object({
        duration: markField(z.number().min(2).max(15).default(5)),
        generateAudio: z.boolean().optional(),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2vSchema, veoOpts)
      // The model has its own .duration constraint via lifted providerOptions key,
      // not the base .durationSeconds. So the LLM now sees both fields. Verify
      // the lifted `duration` field is added.
      const shape = lifted.shape
      expect(shape).toHaveProperty('duration')
    })

    it('rejects duration outside Veo 3.1 range after lift', () => {
      const veoOpts = z.object({
        duration: markField(z.number().min(2).max(15)),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2vSchema, veoOpts)
      const result = lifted.safeParse({
        prompt: 'a clip',
        duration: 30,
      })
      expect(result.success).toBe(false)
    })
  })

  describe('Veo 2 native batch lift', () => {
    it('lifts n: z.number().max(4) for Google Generative AI Veo 2', () => {
      const veo2Opts = z.object({
        n: markField(z.number().int().min(1).max(4)),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2vSchema, veo2Opts)
      // n=5 rejected (Veo 2 max is 4)
      const result = lifted.safeParse({ prompt: 'a clip', n: 5 })
      expect(result.success).toBe(false)
    })

    it('accepts n=4 at the upper bound', () => {
      const veo2Opts = z.object({ n: markField(z.number().int().min(1).max(4)) })
      const lifted = deriveLlmFacingInputSchema(baseT2vSchema, veo2Opts)
      const result = lifted.safeParse({ prompt: 'a clip', n: 4 })
      expect(result.success).toBe(true)
    })
  })

  describe('multi-field lift', () => {
    it('lifts n + duration + fps together when all present', () => {
      const allFields = z.object({
        n: markField(z.number().int().min(1).max(4)),
        duration: markField(z.number().min(2).max(15)),
        fps: markField(z.union([z.literal(24), z.literal(30)])),
      })
      const lifted = deriveLlmFacingInputSchema(baseT2vSchema, allFields)
      const shape = lifted.shape
      expect(shape).toHaveProperty('n')
      expect(shape).toHaveProperty('duration')
      expect(shape).toHaveProperty('fps')
    })

    it('lifted fields override base defaults', () => {
      // Base n: min(1).max(8); Suno opts n: literal(2)
      const sunoOpts = z.object({ n: markField(z.literal(2)) })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, sunoOpts)
      // Lifted schema has n: literal(2), base default n:1 is overridden
      const result = lifted.safeParse({ prompt: 'a song' })
      // n required (literal has no default) — fail
      expect(result.success).toBe(false)
    })
  })

  describe('non-LIFTABLE fields stay in typed providerOptions (v1.2)', () => {
    it('non-LIFTABLE providerOptions fields are nested under input.providerOptions, not top-level', () => {
      // v1.2:non-LIFTABLE fields (negativePrompt / strength / motion) end up
      // inside `input.providerOptions: z.object({...})` so LLM CAN fill them —
      // just not at top level. The "ignored" terminology from v1.1 is wrong;
      // they're nested, not dropped.
      const mixedOpts = z.object({
        n: markField(z.literal(3)), // lifted to top-level
        negativePrompt: z.string().optional(), // nested
        strength: z.number().min(0).max(1).optional(), // nested
        motion: z.enum(['subtle', 'normal', 'dramatic']).optional(), // nested
      })
      const lifted = deriveLlmFacingInputSchema(baseT2iSchema, mixedOpts)
      const shape = lifted.shape
      // n is lifted to top level.
      expect(shape).toHaveProperty('n')
      // negativePrompt / strength / motion are NOT top-level — they're inside
      // the typed input.providerOptions.
      expect(shape).not.toHaveProperty('negativePrompt')
      expect(shape).not.toHaveProperty('strength')
      expect(shape).not.toHaveProperty('motion')
      // But they ARE valid inside providerOptions.
      const ok = lifted.safeParse({
        prompt: 'a thing',
        n: 3,
        providerOptions: {
          negativePrompt: 'blurry',
          strength: 0.7,
          motion: 'normal',
        },
      })
      expect(ok.success).toBe(true)
    })
  })

  describe('output determinism', () => {
    it('is deterministic across calls', () => {
      // Run derive twice on the same input, output schemas should match
      // when serialised the same way (referential equality is too strong,
      // but key order should be stable since the partition iterates the
      // providerOptions shape in declaration order).
      const opts = z.object({
        n: markField(z.literal(2)),
        aspectRatio: markField(z.enum(['1:1', '16:9'])),
        duration: markField(z.number().min(1).max(10)),
      })
      const a = deriveLlmFacingInputSchema(baseT2vSchema, opts)
      const b = deriveLlmFacingInputSchema(baseT2vSchema, opts)
      expect(Object.keys(a.shape)).toEqual(Object.keys(b.shape))
    })
  })

  // ── marker-driven partition byte-stability regression ────────────────────
  // Locks the partition (read LIFT_MARKER) to the exact set AND ORDER an
  // equivalent name-list partition would produce. The always-load tool prefix /
  // KV-cache depends on lifted-field property order, so this pins catalog bytes.
  // Fields are stamped inline via markField() the same way the host
  // `_liftable.ts` `markLiftable()` helper does.
  describe('marker-driven partition (byte stability)', () => {
    it('lifts exactly the marked fields, in declaration order, leaving unmarked under providerOptions', () => {
      // Image-like providerOptions: n/size/aspectRatio marked (host built them
      // via liftable.X()); promptOptimizer is a provider-specific field, not
      // marked, so it must stay nested under input.providerOptions.
      const imageOpts = z.object({
        n: markField(z.number().int().min(1).max(4)),
        size: markField(
          z.enum(['1024x1024', '1536x1024', 'auto']).optional(),
        ),
        aspectRatio: markField(z.enum(['1:1', '16:9']).optional()),
        promptOptimizer: z.boolean().optional(),
      })
      const derived = deriveLlmFacingInputSchema(baseT2iSchema, imageOpts)
      const topLevelKeys = Object.keys(derived.shape)

      // The lifted fields appear at top level in declaration order…
      const liftedTopLevel = topLevelKeys.filter((k) =>
        ['n', 'size', 'aspectRatio'].includes(k),
      )
      expect(liftedTopLevel).toEqual(['n', 'size', 'aspectRatio'])

      // …promptOptimizer is NOT lifted to top level…
      expect(topLevelKeys).not.toContain('promptOptimizer')

      // …it lives inside the typed input.providerOptions instead.
      const poField = derived.shape.providerOptions
      expect(poField).toBeDefined()
      const ok = derived.safeParse({
        prompt: 'a cat',
        n: 2,
        size: '1024x1024',
        aspectRatio: '16:9',
        providerOptions: { promptOptimizer: true },
      })
      expect(ok.success).toBe(true)
    })

    it('produces byte-identical shape to a name-list partition', () => {
      // The strongest byte-stability pin: derive the SAME stamped providerOptions
      // two ways — (a) the live marker-driven function, (b) a reconstruction of
      // the equivalent name-list partition logic — and assert the derived
      // Pattern.input shape is key-for-key identical (set + order). Order is NOT
      // simply the source declaration order: `.extend(lifted)` keeps base-present
      // keys (n, fps) in their base position and appends genuinely-new keys
      // (duration). Both code paths feed the SAME merge step the SAME lifted
      // object, so the catalog bytes are the same either way.
      const videoOpts = z.object({
        n: markField(z.number().int().min(1).max(4)),
        duration: markField(z.number().min(2).max(15)),
        fps: markField(z.union([z.literal(24), z.literal(30)])),
        cameraControl: z.enum(['fixed', 'pan']).optional(),
      })
      const markerDerived = deriveLlmFacingInputSchema(baseT2vSchema, videoOpts)

      // Reconstruct a name-list partition over the same fields the host marks,
      // as a local test fixture (the live function reads the marker, not names).
      const liftNames = ['n', 'size', 'aspectRatio', 'resolution', 'duration', 'fps']
      const optShape = videoOpts.shape as Record<string, ZodTypeAny>
      const oldLifted: Record<string, ZodTypeAny> = {}
      const oldLiftedNames = new Set<string>()
      for (const name of liftNames) {
        if (optShape[name] !== undefined) {
          oldLifted[name] = optShape[name]
          oldLiftedNames.add(name)
        }
      }
      const oldRemaining: Record<string, ZodTypeAny> = {}
      for (const name of Object.keys(optShape)) {
        if (!oldLiftedNames.has(name)) oldRemaining[name] = optShape[name]
      }
      let nameListDerived: z.ZodObject<ZodRawShape> = baseT2vSchema.omit({
        providerOptions: true,
      }) as z.ZodObject<ZodRawShape>
      if (Object.keys(oldLifted).length > 0)
        nameListDerived = nameListDerived.extend(oldLifted as ZodRawShape)
      if (Object.keys(oldRemaining).length > 0)
        nameListDerived = nameListDerived.extend({
          providerOptions: z.object(oldRemaining as ZodRawShape).optional(),
        } as ZodRawShape)

      // Top-level key set AND order are identical between the two partitions.
      expect(Object.keys(markerDerived.shape)).toEqual(
        Object.keys(nameListDerived.shape),
      )
      // cameraControl (unmarked / non-name) is nested, not top-level.
      expect(Object.keys(markerDerived.shape)).not.toContain('cameraControl')
      // And the nested providerOptions field set + order match too.
      const markerPo = markerDerived.shape.providerOptions as z.ZodOptional<
        z.ZodObject<ZodRawShape>
      >
      const namePo = nameListDerived.shape.providerOptions as z.ZodOptional<
        z.ZodObject<ZodRawShape>
      >
      expect(Object.keys(markerPo.unwrap().shape)).toEqual(
        Object.keys(namePo.unwrap().shape),
      )
    })

    it('does not lift a liftable-NAMED field that lacks the marker', () => {
      // OSS reads only the marker now — a providerOptions field literally named
      // `n` but not stamped is NOT lifted as a top-level override; it stays
      // nested under input.providerOptions (the marker, not the name, decides).
      // The base schema's own top-level `n` (max 8, default 1) is untouched, so
      // the unmarked provider `n` does NOT impose its max(4) at top level.
      const opts = z.object({
        n: z.number().int().min(1).max(4), // unmarked → NOT lifted
      })
      const derived = deriveLlmFacingInputSchema(baseT2iSchema, opts)
      // Top-level n is still the base constraint: n=8 (>4) accepted because the
      // unmarked provider n(max 4) was NOT lifted to override it.
      const topLevel = derived.safeParse({ prompt: 'x', n: 8 })
      expect(topLevel.success).toBe(true)
      // The unmarked n lives inside the typed providerOptions, where its own
      // max(4) applies: n=5 there is rejected.
      const nested = derived.safeParse({
        prompt: 'x',
        n: 1,
        providerOptions: { n: 5 },
      })
      expect(nested.success).toBe(false)
    })
  })

  // ── v1.2 new behavior coverage ──────────────────────────────────────────
  describe('v1.2 typed input.providerOptions (replaces z.record)', () => {
    it('replaces opaque z.record with typed z.object containing non-LIFTABLE fields', () => {
      const veoOpts = z.object({
        duration: markField(z.number().min(2).max(15)), // LIFTABLE
        cameraControl: z.enum(['fixed', 'pan', 'zoom', 'dolly']).optional(),
        negativePrompt: z.string().optional(),
        generateAudio: z.boolean().optional(),
      })
      const derived = deriveLlmFacingInputSchema(baseT2vSchema, veoOpts)

      // input.providerOptions accepts cameraControl='fixed' (typed enum value).
      const ok = derived.safeParse({
        prompt: 'a sweeping landscape',
        duration: 5,
        providerOptions: { cameraControl: 'fixed', generateAudio: true },
      })
      expect(ok.success).toBe(true)

      // Invalid enum value rejected (was impossible with z.record(z.unknown())).
      const bad = derived.safeParse({
        prompt: 'a sweeping landscape',
        duration: 5,
        providerOptions: { cameraControl: 'spaceship' },
      })
      expect(bad.success).toBe(false)
    })

    it('omits input.providerOptions when all model fields lifted (no remaining)', () => {
      const allLiftedOpts = z.object({
        n: markField(z.literal(2)),
        duration: markField(z.number().min(2).max(15)),
      })
      const derived = deriveLlmFacingInputSchema(baseT2vSchema, allLiftedOpts)
      // No leftover → input.providerOptions field absent
      expect(derived.shape).not.toHaveProperty('providerOptions')
    })
  })

  // ── ASSET_MARKER host-injected-from-slot fields (Phase 1) ────────────────
  // A providerOptions field stamped with ASSET_MARKER is a host-injected wire
  // field (e.g. Kling's file-typed imageTail). The LLM must never see it — the
  // host fills it from a resolved slot asset at dispatch. OSS reads only the
  // marker's PRESENCE (field-name- and slot-agnostic) and drops the field from
  // BOTH the lifted top level and the nested providerOptions.
  describe('ASSET_MARKER host-injected fields', () => {
    it('drops ASSET_MARKER fields from both top-level and nested providerOptions', () => {
      const base = z.object({ prompt: z.string() })
      const po = z.object({
        mode: z.string().optional(),
        imageTail: markAsset(z.string().optional(), 'endFrame'),
      })
      const derived = deriveLlmFacingInputSchema(base, po)
      expect(derived.shape).not.toHaveProperty('imageTail')
      const poShape = (
        derived.shape.providerOptions as z.ZodOptional<
          z.ZodObject<z.ZodRawShape>
        >
      ).unwrap().shape
      expect(Object.keys(poShape)).toContain('mode')
      expect(Object.keys(poShape)).not.toContain('imageTail')
    })
  })
})
