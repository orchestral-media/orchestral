// automatic-speech-recognition over the AI SDK's `transcribe`.

import { transcribe, type TranscriptionModel } from 'ai'
import type {
  DispatchContext,
  DispatchResult,
  ModelCapability,
  ResolvedAssetRef,
} from '@orchestral/core'

import {
  type AdapterOptions,
  asRecord,
  buildRecord,
  dispatchEnvelope,
  providerOptionsFor,
  resolveIdentity,
} from './envelope'

/**
 * A resolved AI SDK transcription model OBJECT — `TranscriptionModel` minus
 * the bare-id string form. Build one with `openai.transcription('whisper-1')`
 * (or any provider's `.transcription()`).
 */
export type TranscriptionModelInstance = Exclude<TranscriptionModel, string>

/**
 * What `loadAudio` hands back: the audio bytes, or a `URL` the AI SDK
 * downloads itself (`https:`, `file:`, or a `data:` URI — which is what a
 * standalone host's `text-to-speech` output carries). The media type is
 * sniffed from the bytes by the SDK either way.
 */
export type AudioSource = Uint8Array | ArrayBuffer | URL

/**
 * The one thing a transcription adapter cannot derive: how to turn the
 * resolved `source` asset into audio. An orchestral `assetId` is an opaque
 * host identifier — `@orchestral/core` never defines how to read its bytes —
 * so the host that owns the asset store supplies the loader.
 */
export interface TranscriptionAdapterOptions extends AdapterOptions {
  /**
   * Resolve the `source` slot's `ResolvedAssetRef` (the real `assetId` the
   * runtime's resolution pass produced from `input.references.source`) to
   * audio the SDK can consume. Receives the dispatch context as well, for
   * hosts whose store is keyed by session or project.
   */
  loadAudio: (
    ref: ResolvedAssetRef,
    ctx: DispatchContext,
  ) => Promise<AudioSource> | AudioSource
}

const SOURCE_SLOT = 'source'

/**
 * Wrap an AI SDK transcription model as an `automatic-speech-recognition`
 * `ModelCapability`.
 *
 * Reads the `source` audio asset from `ctx.assets` (the resolution-pass output
 * for the pattern's required `source` slot) and loads it through
 * `options.loadAudio`; a flat `input.providerOptions` is nested under the
 * provider key. Returns an `AutomaticSpeechRecognitionOutput`: `text`,
 * `segments` when the provider gave any (already in seconds), `language` and
 * `audioDurationMs` when reported, `cost: null`.
 *
 * Not mapped: `input.language` / `input.prompt` / `timestamps` / `format` —
 * the AI SDK's `transcribe` has no shared fields for them; they are
 * provider-specific `providerOptions` (see README). `words` is never emitted.
 */
export function fromTranscriptionModel(
  model: TranscriptionModelInstance,
  options: TranscriptionAdapterOptions,
): ModelCapability {
  const identity = resolveIdentity(model, options)
  return {
    ...buildRecord(identity, options, {
      capability: 'automatic-speech-recognition',
      inputs: ['audio'],
      outputs: ['text'],
    }),
    async call<I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> {
      const fields = asRecord(input)
      const source = ctx.assets?.find((ref) => ref.slot === SOURCE_SLOT)
      if (!source) {
        throw new Error(
          `automatic-speech-recognition call: no resolved asset in slot "${SOURCE_SLOT}" on ctx.assets — the runtime fills it from input.references.${SOURCE_SLOT}`,
        )
      }
      const audio = await options.loadAudio(source, ctx)
      const providerOptions = providerOptionsFor(identity.sdkProviderKey, ctx, fields)

      const startedAt = Date.now()
      const result = await transcribe({
        model,
        audio,
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: ctx.signal,
      })

      const output = {
        modality: 'text' as const,
        text: result.text,
        ...(result.segments.length > 0
          ? {
              segments: result.segments.map((segment) => ({
                startSecond: segment.startSecond,
                endSecond: segment.endSecond,
                text: segment.text,
              })),
            }
          : {}),
        ...dispatchEnvelope(identity, startedAt),
        ...(result.durationInSeconds !== undefined
          ? {
              audioDurationMs: Math.max(
                0,
                Math.round(result.durationInSeconds * 1000),
              ),
            }
          : {}),
        ...(result.language !== undefined ? { language: result.language } : {}),
      }
      return { output: output as O }
    },
  }
}
