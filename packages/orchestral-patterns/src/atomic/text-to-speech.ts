// text-to-speech — atomic Pattern factory.
//
// Voice cloning is exposed via the
// `input.references.voiceClone` slot — when the user provides a reference
// audio handle, a resolved model that supports cloning accepts it.
// Provider-specific voice settings (stability / similarityBoost / etc.) surface
// in the derived per-model providerOptions.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, producedAssetShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// ai-sdk decoupling: the base carries NO ai-sdk-shaped fields — only
// `text` + `references` (references.voiceClone = reference audio for cloning).
// The per-model speech params come entirely from the resolved model's
// `liftable.X()` declarations, lifted onto top level by
// `deriveLlmFacingInputSchema` at find_pattern render time.

export const TextToSpeechPrimaryInputSchema = z.object({
  text: z
    .string()
    .min(1, 'text required')
    .describe('Text content to synthesize into spoken audio.'),
})

const ASSET_NEEDS = [
  {
    slot: 'voiceClone',
    modality: 'audio',
    cardinality: 'single',
    required: false,
    description:
      'Short reference audio (5-30s of clear speech) to clone the voice; omit to use a preset voice. Voice-clone tuning (stability, similarity boost) surfaces in the derived providerOptions schema.',
  },
] as const satisfies readonly AssetNeed[]

export type TextToSpeechInput = z.infer<typeof TextToSpeechPrimaryInputSchema> & {
  references?: DerivedReferences<typeof ASSET_NEEDS>
}

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal.
// Produced media is carried in `assets[]` (legacy single assetId / audioUrl
// removed). The adapter no longer fabricates handles — the canonical handle is
// attached by the host from the SessionAssetStore after recording. assetId is
// stripped by toModelOutput's projection, so the LLM only ever sees the handle.
export const TextToSpeechOutputSchema = z.object({
  modality: z.literal('audio'),
  assets: z
    .array(z.object(producedAssetShape('audio')))
    .describe('Produced audio — one element per generated asset.'),
  ...dispatchEnvelopeShape,
  /** Length of the synthesized audio in milliseconds (not API latency). */
  audioDurationMs: z.number().int().min(0).optional(),
})

export type TextToSpeechOutput = z.infer<typeof TextToSpeechOutputSchema>

// ── Pattern factory ─────────────────────────────────────────────────────

export const TEXT_TO_SPEECH_PATTERN_ID = 'text-to-speech'

export interface TextToSpeechPatternInit {
  alternatives?: readonly Alternative<TextToSpeechInput, TextToSpeechOutput>[]
}

export function createTextToSpeechPattern(
  init: TextToSpeechPatternInit = {},
): AtomicPattern<TextToSpeechInput, TextToSpeechOutput> {
  return defineAtomicPattern<TextToSpeechInput, TextToSpeechOutput>({
    id: TEXT_TO_SPEECH_PATTERN_ID,
    searchHint: 'synthesize speech audio from text (TTS)',
    namespace: 'audio-gen',
    exposure: { chatTurn: true, agentLoop: true, canvas: true },
    description:
      'Synthesize speech audio from text. Capability: text-to-speech. Voice cloning is opt-in via input.references.voiceClone — provide a short audio handle and a resolved model that supports cloning will clone the voice.',
    primary: {
      tool: {
        description:
          'Synthesize speech audio from text using a provider voice. Use when the user asks to speak, say, read aloud, narrate, voice, or synthesize text as spoken audio in a given voice or language. To clone a specific voice the user provided, pass the audio handle via input.references.voiceClone.',
        inputs: TextToSpeechPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: TextToSpeechOutputSchema,
    // No first-party default. text-to-audio is the catalog's only other audio
    // producer, but its `prompt` is a DESCRIPTION of a sound, not a script:
    // handing it this pattern's `text` yields audio *about* those words instead
    // of those words spoken, and `voiceClone` has no counterpart there (that
    // pattern declares no assetNeeds at all). No `losses` entry can state that
    // honestly — what goes missing is speech itself, which is the capability.
    // DESIGN: tts-no-fallback
    alternatives: init.alternatives,
    // voiceClone (optional single audio); opt-in via UI, no auto-follow.
    assetNeeds: ASSET_NEEDS,
  })
}

/** Typed `ctx.step` sugar — dispatch text-to-speech from a meta compose(). */
export const textToSpeech = createPatternFn<
  TextToSpeechInput,
  TextToSpeechOutput
>(TEXT_TO_SPEECH_PATTERN_ID)
