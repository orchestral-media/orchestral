// text-to-audio — Pattern factory.
// primary path = generate music / SFX / ambient from a text prompt.
// `mode` is an input field; all backing models share the same dispatch
// shape.
//
// Distinct from text-to-speech: this generates music / SFX / ambient beds,
// not spoken narration.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// - format → outputFormat (matches ai-sdk naming)
// - genre / bpm / tags → providerOptions (provider-specific; each vendor
//   names them differently)
// - added n (some models force a fixed output count; some SFX models return
//   multiple candidates; derive() lifts constraints like z.literal(2) from
//   providerOptions)
//
// Adapter contract: there is no shared generate-audio primitive to route
// through, so an adapter for this capability calls the provider's music / SFX
// endpoint itself and maps `prompt` / `mode` / `durationSeconds` /
// `outputFormat` / `n` / `seed` onto that provider's request shape. `mode`
// shapes the prompt style rather than selecting a different dispatch path.

export const TextToAudioPrimaryInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt required')
    .describe(
      'Text description of the music, SFX, or ambient bed to generate.',
    ),
  mode: z
    .enum(['music', 'sfx', 'ambient'])
    .default('music')
    .describe(
      '`music` = full composition; `sfx` = one-shot sound effect; `ambient` = looping atmospheric bed. Cross-provider abstraction.',
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe(
      'Number of audio outputs. derive() lifts per-model constraints (e.g. a model that forces exactly 2, or one that allows multiple SFX candidates).',
    ),
  durationSeconds: z
    .number()
    .min(1)
    .max(120)
    .default(10)
    .describe('Target length of the generated audio in seconds.'),
  outputFormat: z
    .enum(['mp3', 'wav', 'flac'])
    .default('mp3')
    .describe('Output audio container/codec.'),
  seed: z.number().int().optional().describe('Deterministic seed.'),
  // `providerOptions` placeholder removed — derive injects a typed schema at
  // find_pattern render time based on the resolved model (e.g. a lyrics field,
  // or a bpm field, depending on the model).
})

export type TextToAudioInput = z.infer<typeof TextToAudioPrimaryInputSchema>

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal.
// Produced media is carried in `assets[]` (legacy single assetId / audioUrl
// removed). The adapter no longer fabricates handles — the canonical handle is
// attached by the host from the SessionAssetStore after recording. assetId is
// stripped by toModelOutput's projection, so the LLM only ever sees the handle.
export const TextToAudioOutputSchema = z.object({
  modality: z.literal('audio'),
  assets: z
    .array(z.object(producedAssetShape('audio')))
    .describe('Produced audio — one element per generated asset.'),
  ...dispatchEnvelopeShape,
  /** Length of the generated audio in milliseconds (not API latency). */
  audioDurationMs: z.number().int().min(0).optional(),
})

export type TextToAudioOutput = z.infer<typeof TextToAudioOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const TEXT_TO_AUDIO_PATTERN_ID = 'text-to-audio'

export interface TextToAudioPatternInit {
  alternatives?: readonly Alternative<TextToAudioInput, TextToAudioOutput>[]
}

export function createTextToAudioPattern(
  init: TextToAudioPatternInit = {},
): AtomicPattern<TextToAudioInput, TextToAudioOutput> {
  return defineAtomicPattern<TextToAudioInput, TextToAudioOutput>({
    id: TEXT_TO_AUDIO_PATTERN_ID,
    searchHint: 'compose music or sound effects from a prompt',
    namespace: 'audio-gen',
    description:
      'Generate music, sound effects, or ambient audio from a text prompt. Capability: text-to-audio. Primary path only; mode is an input field, not a variant.',
    primary: {
      tool: {
        description:
          'Generate music, sound effects, or ambient audio from a text prompt. Use when the user asks to compose, produce, score, or generate a song, music track, SFX, sound effect, ambient bed, or instrumental from a text description. Distinct from text-to-speech, which synthesizes spoken narration.',
        inputs: TextToAudioPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: TextToAudioOutputSchema,
    // No first-party default — the mirror of the note on text-to-speech: sending
    // this prompt there reads "lo-fi beat, 90 bpm, rain" aloud in a synthetic
    // voice. A description of a sound and a script to be spoken are different
    // kinds of text, so neither direction degrades into the other.
    alternatives: init.alternatives,
    // text-to-audio takes no asset input (no assetNeeds).
  })
}

// Dispatch-facing input uses the zod INPUT type (schema `.default()` fields
// stay optional — the sub-step path applies no parse).
type TextToAudioDispatchInput = z.input<typeof TextToAudioPrimaryInputSchema>

/** Typed `ctx.step` sugar — dispatch text-to-audio from a meta compose(). */
export const textToAudio = createPatternFn<
  TextToAudioDispatchInput,
  TextToAudioOutput
>(TEXT_TO_AUDIO_PATTERN_ID)
