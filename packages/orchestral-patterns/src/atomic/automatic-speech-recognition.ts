// automatic-speech-recognition — Pattern factory.
// primary path = transcribe spoken audio to text (Whisper-class ASR).
// All ASR backends share the same dispatch shape and
// differ only in the model the host's CapabilityRouter resolves.

import { z } from 'zod'
import { createPatternFn, defineAtomicPattern, dispatchEnvelopeShape, type AtomicPattern, type Alternative, type AssetNeed, type DerivedReferences } from '@orchestral/core'

// ── primary input schema ────────────────────────────────────────────────
// - format / timestamps / diarize / numSpeakers → providerOptions (each
//   provider names these differently — Whisper uses response_format /
//   timestamp_granularities; AssemblyAI uses utterance / word_boost;
//   Deepgram uses smart_format / diarize)
// - keep language / prompt (the shared ai-sdk transcribe fields)

export const AutomaticSpeechRecognitionPrimaryInputSchema = z.object({
  language: z
    .string()
    .optional()
    .describe(
      "Optional BCP-47 language hint, e.g. 'en-US' / 'zh-CN'. Omit for auto-detect.",
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional decoding hint to bias the recognizer toward proper nouns, acronyms, or domain jargon. Providers without prompt support silently ignore this.',
    ),
  // No `providerOptions` field here on purpose: `deriveLlmFacingInputSchema`
  // injects a typed one at find_pattern render time, based on the resolved
  // top-1 model's transcription ship-data.
})

const ASSET_NEEDS = [
  {
    slot: 'source',
    modality: 'audio',
    cardinality: 'single',
    required: true,
    description: 'The audio recording to transcribe.',
  },
] as const satisfies readonly AssetNeed[]

/**
 * Transcription params the ASR adapter reads off the top level of the Pattern
 * input. At find_pattern render time they are lifted onto `Pattern.input`
 * per-model from the model's providerOptions schema (the LLM fills them from the
 * derived schema); the base zod schema stays model-agnostic and carries only
 * `language` / `prompt`. A meta compose() has no LLM lift step, so it sets them
 * directly here.
 */
export interface AsrTranscriptionParams {
  /** Timestamp granularity: 'segment' | 'word' | 'none'. */
  timestamps?: 'segment' | 'word' | 'none'
  /** Output container the host requests from the provider. */
  format?: 'json' | 'srt' | 'vtt' | 'text'
}

export type AutomaticSpeechRecognitionInput = z.infer<
  typeof AutomaticSpeechRecognitionPrimaryInputSchema
> & { references?: DerivedReferences<typeof ASSET_NEEDS> } & AsrTranscriptionParams

// ── outputs ───────────────────────────────────────────────────────────────

// outputs.modality literal (text output from audio).
export const AutomaticSpeechRecognitionOutputSchema = z.object({
  modality: z.literal('text'),
  /** Primary transcribed text — always populated. */
  text: z.string(),
  /**
   * Segment-level timestamps when `timestamps !== 'none'`. Times are in
   * SECONDS (float), never milliseconds — adapters normalise provider units
   * (Whisper seconds, Deepgram seconds, millisecond-based APIs) into this shape
   * before returning, so downstream subtitle formatting can rely on one unit.
   */
  segments: z
    .array(
      z.object({
        startSecond: z.number(),
        endSecond: z.number(),
        text: z.string(),
      }),
    )
    .optional(),
  /** Word-level timestamps when `timestamps === 'word'`. Same seconds-based shape. */
  words: z
    .array(
      z.object({
        startSecond: z.number(),
        endSecond: z.number(),
        text: z.string(),
      }),
    )
    .optional(),
  ...dispatchEnvelopeShape,
  /** Length of the source audio in milliseconds (not API latency). */
  audioDurationMs: z.number().int().min(0).optional(),
  /** Detected (or echoed) BCP-47 language tag. */
  language: z.string().optional(),
})

export type AutomaticSpeechRecognitionOutput = z.infer<
  typeof AutomaticSpeechRecognitionOutputSchema
>

// ── Pattern factory ─────────────────────────────────────────────────────

export const AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID =
  'automatic-speech-recognition'

export interface AutomaticSpeechRecognitionPatternInit {
  alternatives?: readonly Alternative<
    AutomaticSpeechRecognitionInput,
    AutomaticSpeechRecognitionOutput
  >[]
}

export function createAutomaticSpeechRecognitionPattern(
  init: AutomaticSpeechRecognitionPatternInit = {},
): AtomicPattern<
  AutomaticSpeechRecognitionInput,
  AutomaticSpeechRecognitionOutput
> {
  return defineAtomicPattern<
    AutomaticSpeechRecognitionInput,
    AutomaticSpeechRecognitionOutput
  >({
    id: AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID,
    searchHint: 'transcribe spoken audio to text (Whisper-class ASR)',
    namespace: 'audio-gen',
    description:
      'Transcribe spoken audio into text. Capability: automatic-speech-recognition. Primary path only; routing layer picks a concrete Whisper-class model.',
    primary: {
      tool: {
        description:
          'Transcribe spoken audio into text. Use when the user asks to transcribe, recognize, recognise, listen to, caption, subtitle, or convert speech in an audio recording into written text (Whisper-style ASR).',
        inputs: AutomaticSpeechRecognitionPrimaryInputSchema,
      },
      modelTags: [],
    },
    outputs: AutomaticSpeechRecognitionOutputSchema,
    // No first-party default: nothing else in the catalog listens. image-to-text
    // reads pixels, and a transcript cannot be reconstructed from anything but
    // the recording — a guessed transcript is fabrication, not degradation.
    alternatives: init.alternatives,
    // source required (the audio to transcribe). Output is text, so no
    // outputs.assets[] (only declares the input need).
    assetNeeds: ASSET_NEEDS,
  })
}

/** Typed `ctx.step` sugar — dispatch ASR from a meta compose(). */
export const automaticSpeechRecognition = createPatternFn<
  AutomaticSpeechRecognitionInput,
  AutomaticSpeechRecognitionOutput
>(AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID)
