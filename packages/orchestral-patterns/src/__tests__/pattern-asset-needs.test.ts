// AssetLedger C2 — pure-OSS additive coverage.
//
// Asserts each first-party Pattern factory now carries `assetNeeds` derived
// from its bindings schema (§5.5), and that media-producing patterns' outputs
// schemas accept the additive `assets[]` array (§6) while still accepting the
// legacy single `assetId` shape (coexistence, old path untouched).

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { deriveReferencesSchema } from '@orchestral/core'
import type { AssetNeed } from '@orchestral/core'
import type { Pattern } from '@orchestral/core'

import { createAutomaticSpeechRecognitionPattern } from '@orchestral/patterns'
import { createImageToImagePattern } from '@orchestral/patterns'
import { createImageToImageViaCaptionPattern } from '@orchestral/patterns'
import { createImageToTextPattern } from '@orchestral/patterns'
import { createImageToVideoPattern } from '@orchestral/patterns'
import { createTextGenerationPattern } from '@orchestral/patterns'
import { createTextToAudioPattern } from '@orchestral/patterns'
import { createTextToImagePattern } from '@orchestral/patterns'
import { createTextToSpeechPattern } from '@orchestral/patterns'
import { createTextToVideoPattern } from '@orchestral/patterns'
import { createVideoToVideoPattern } from '@orchestral/patterns'

import { TextToImageOutputSchema } from '@orchestral/patterns'
import { ImageToImageOutputSchema } from '@orchestral/patterns'
import { TextToVideoOutputSchema } from '@orchestral/patterns'
import { ImageToVideoOutputSchema } from '@orchestral/patterns'
import { VideoToVideoOutputSchema } from '@orchestral/patterns'
import { TextToSpeechOutputSchema } from '@orchestral/patterns'
import { TextToAudioOutputSchema } from '@orchestral/patterns'
import { ImageToImageViaCaptionOutputSchema } from '@orchestral/patterns'

// Expected assetNeeds per Pattern, derived 1:1 from each factory's bindings
// schema + requiresPriorAssets. `undefined` = no asset input bindings → factory
// omits the field entirely.
const EXPECTED: Record<string, readonly AssetNeed[] | undefined> = {
  'text-to-image': [
    {
      slot: 'reference',
      modality: 'image',
      cardinality: 'array',
      required: false,
      description:
        'Reference image(s) to preserve subject identity / face / style (IP-Adapter / InstantID / PuLID class). Provider-specific scale / strength (e.g. providerOptions.ip_adapter_scale) surfaces in the derived schema. For a trained LoRA style no asset is needed — supply providerOptions.loras [{path, scale}].',
    },
    {
      slot: 'control',
      modality: 'image',
      cardinality: 'single',
      required: false,
      description:
        'Control image (pose / depth / canny / scribble map) to match a specific pose or structural layout. Control type / strength surface in the derived providerOptions schema (e.g. providerOptions.control_type).',
    },
  ],
  'image-to-image': [
    {
      slot: 'source',
      modality: 'image',
      cardinality: 'array',
      required: true,
      description:
        'The image(s) to edit, extend (outpaint — direction/pixels via providerOptions.outpaint when the model supports it), or fuse — some models accept multiple source images for multi-source fusion (per-model max varies). When passing multiple images (e.g. a subject photo plus a style/reference photo), describe each image\'s role in the prompt text — the model sees them in array order. To keep several characters/subjects consistent in one frame (e.g. two characters sharing a shot), pass each one\'s reference image here so the model fuses them all — passing only one loses the others\' identity.',
    },
    {
      slot: 'mask',
      modality: 'image',
      cardinality: 'single',
      required: false,
      description:
        'Mask image for masked editing / inpaint — white = region to edit, black = preserve. Per-model mask blur / strength surface in the derived providerOptions schema.',
    },
  ],
  'image-to-text': [
    {
      slot: 'source',
      modality: 'image',
      cardinality: 'array',
      required: true,
      description:
        'The image(s) to read — a single handle for caption / describe / OCR, or an array for multi-image comparison / grounded reasoning.',
    },
  ],
  'text-to-video': [
    {
      slot: 'reference',
      modality: 'image',
      cardinality: 'array',
      required: false,
      description:
        'Style / subject reference image(s); models without explicit reference support ignore them gracefully.',
    },
    {
      slot: 'endFrame',
      modality: 'image',
      cardinality: 'single',
      required: false,
      description:
        'End-frame image for first→last interpolation (supported by some models; surfaces as a first-class field in the derived per-model schema).',
    },
  ],
  'image-to-video': [
    {
      slot: 'startFrame',
      modality: 'image',
      cardinality: 'single',
      required: true,
      description: 'The image to animate — becomes the first frame.',
    },
    {
      slot: 'endFrame',
      modality: 'image',
      cardinality: 'single',
      required: false,
      description:
        'End-frame image for first→last interpolation (supported by some models; surfaces as a first-class field in the derived per-model schema).',
    },
    {
      slot: 'reference',
      modality: 'image',
      cardinality: 'array',
      required: false,
      description: 'Reference image(s) for style or subject guidance.',
    },
    {
      slot: 'referenceVideo',
      modality: 'video',
      cardinality: 'array',
      required: false,
      description: 'Reference video(s) for motion guidance / motion transfer.',
    },
    {
      slot: 'referenceAudio',
      modality: 'audio',
      cardinality: 'array',
      required: false,
      description: 'Reference audio for lip-sync or rhythm guidance.',
    },
  ],
  'video-to-video': [
    {
      slot: 'source',
      modality: 'video',
      cardinality: 'single',
      required: true,
      description: 'The video to transform.',
    },
    {
      slot: 'reference',
      modality: 'image',
      cardinality: 'array',
      required: false,
      description:
        'Style reference image(s) guiding the visual look in restyle mode; other modes ignore them.',
    },
  ],
  'text-to-speech': [
    {
      slot: 'voiceClone',
      modality: 'audio',
      cardinality: 'single',
      required: false,
      description:
        'Short reference audio (5-30s of clear speech) to clone the voice; omit to use a preset voice. Voice-clone tuning (stability, similarity boost) surfaces in the derived providerOptions schema.',
    },
  ],
  'text-to-audio': undefined,
  'automatic-speech-recognition': [
    {
      slot: 'source',
      modality: 'audio',
      cardinality: 'single',
      required: true,
      description: 'The audio recording to transcribe.',
    },
  ],
  'text-generation': undefined,
  'meta_image-to-image-via-caption': [
    {
      slot: 'source',
      modality: 'image',
      cardinality: 'array',
      required: true,
      description:
        'The image(s) to edit — captioned together, then regenerated from that caption round-trip (subject identity is not preserved).',
    },
  ],
}

const factories: Array<() => Pattern<unknown, unknown>> = [
  () => createTextToImagePattern() as Pattern<unknown, unknown>,
  () => createImageToImagePattern() as Pattern<unknown, unknown>,
  () => createImageToTextPattern() as Pattern<unknown, unknown>,
  () => createTextToVideoPattern() as Pattern<unknown, unknown>,
  () => createImageToVideoPattern() as Pattern<unknown, unknown>,
  () => createVideoToVideoPattern() as Pattern<unknown, unknown>,
  () => createTextToSpeechPattern() as Pattern<unknown, unknown>,
  () => createTextToAudioPattern() as Pattern<unknown, unknown>,
  () => createAutomaticSpeechRecognitionPattern() as Pattern<unknown, unknown>,
  () => createTextGenerationPattern() as Pattern<unknown, unknown>,
  () => createImageToImageViaCaptionPattern() as Pattern<unknown, unknown>,
]

describe('Pattern.assetNeeds (AssetLedger §5.5)', () => {
  for (const factory of factories) {
    const pattern = factory()
    it(`${pattern.id} derives assetNeeds matching its bindings`, () => {
      const expected = EXPECTED[pattern.id]
      if (expected === undefined) {
        // No asset input bindings → factory omits assetNeeds entirely.
        expect(pattern.assetNeeds).toBeUndefined()
      } else {
        expect(pattern.assetNeeds).toEqual(expected)
      }
    })
  }

  // SSOT enforcement: declaring assetNeeds is only half the contract — the
  // derived `references` field must actually land in the LLM-facing inputs
  // (AtomicPattern ctor does it; meta literals must call
  // extendInputsWithReferences themselves). This sweep turns that convention
  // into an invariant: a future factory that declares assetNeeds but skips
  // the injection (or passes a stale list) fails here, not in production.
  for (const factory of factories) {
    const pattern = factory()
    if (!pattern.assetNeeds || pattern.assetNeeds.length === 0) continue
    it(`${pattern.id} injects the assetNeeds-derived references field into its tool inputs`, () => {
      const inputs =
        pattern.kind === 'meta' ? pattern.tool.inputs : pattern.primary?.tool.inputs
      const shape = (inputs as unknown as z.ZodObject<z.ZodRawShape>).shape
      expect(shape.references).toBeDefined()
      // Rendered bytes must equal the derivation from this pattern's own
      // assetNeeds — catches both a skipped injection and a desynced list.
      const derived = deriveReferencesSchema(pattern.assetNeeds)!
      expect(JSON.stringify(z.toJSONSchema(shape.references as z.ZodType))).toBe(
        JSON.stringify(z.toJSONSchema(derived)),
      )
    })
  }

  it('every asset-binding Pattern declares at least one need; required slots only where requiresPriorAssets is required', () => {
    // image-to-image source is required (.min(1) + requiresPriorAssets required).
    const i2i = createImageToImagePattern()
    const source = i2i.assetNeeds?.find((n) => n.slot === 'source')
    expect(source?.required).toBe(true)
    expect(source?.cardinality).toBe('array')

    // text-to-image references are all opt-in → none required.
    const t2i = createTextToImagePattern()
    expect(t2i.assetNeeds?.every((n) => n.required === false)).toBe(true)
  })
})

describe('outputs.assets[] (AssetLedger §6 — C3b-2 收口)', () => {
  // Media-producing patterns: outputs are now collapsed onto `assets[]` (one
  // element per produced asset). Legacy single `assetId` / `<x>Url` deleted —
  // the schema REQUIRES assets[] and rejects the legacy-only shape.
  const mediaSchemas: Array<{
    id: string
    schema: { parse: (v: unknown) => unknown }
    modality: 'image' | 'video' | 'audio'
    extra?: Record<string, unknown>
  }> = [
    { id: 'text-to-image', schema: TextToImageOutputSchema, modality: 'image' },
    { id: 'image-to-image', schema: ImageToImageOutputSchema, modality: 'image' },
    { id: 'text-to-video', schema: TextToVideoOutputSchema, modality: 'video' },
    { id: 'image-to-video', schema: ImageToVideoOutputSchema, modality: 'video' },
    { id: 'video-to-video', schema: VideoToVideoOutputSchema, modality: 'video' },
    { id: 'text-to-speech', schema: TextToSpeechOutputSchema, modality: 'audio' },
    { id: 'text-to-audio', schema: TextToAudioOutputSchema, modality: 'audio' },
    {
      id: 'meta_image-to-image-via-caption',
      schema: ImageToImageViaCaptionOutputSchema,
      modality: 'image',
      extra: { degraded: true },
    },
  ]

  for (const { id, schema, modality, extra } of mediaSchemas) {
    it(`${id} output requires assets[] (legacy single assetId deleted)`, () => {
      const base = {
        modality,
        cost: 0.01,
        latencyMs: 100,
        model: 'p:m',
        provider: 'p',
        ...(extra ?? {}),
      }

      // Legacy-only shape (assetId, no assets[]) is now REJECTED.
      expect(() => schema.parse({ ...base, assetId: 'legacy-asset-1' })).toThrow()

      // assets[] is the canonical produced-media carrier. Adapter elements carry
      // assetId + modality (+ optional url/cost) — NO handle; the host attaches
      // the canonical handle from the SessionAssetStore after record.
      const withAssets = {
        ...base,
        assets: [
          {
            assetId: 'asset-abc',
            modality,
            url: 'https://example.com/a',
            cost: 0.005,
          },
        ],
      }
      expect(() => schema.parse(withAssets)).not.toThrow()

      // Multi-asset (n>1) shape parses — one element per produced asset.
      const multi = {
        ...base,
        assets: [
          { assetId: 'asset-a1', modality },
          { assetId: 'asset-a2', modality },
        ],
      }
      expect(() => schema.parse(multi)).not.toThrow()
    })

    it(`${id} assets[] element rejects wrong modality literal`, () => {
      const bad = {
        modality,
        cost: 0.01,
        latencyMs: 100,
        model: 'p:m',
        provider: 'p',
        ...(extra ?? {}),
        assets: [
          {
            assetId: 'asset-abc',
            modality: modality === 'image' ? 'video' : 'image',
          },
        ],
      }
      expect(() => schema.parse(bad)).toThrow()
    })
  }
})
