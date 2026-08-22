// text-to-speech over the AI SDK's `generateSpeech`.

import { generateSpeech, type SpeechModel } from 'ai'
import type {
  Artifact,
  CallEvents,
  DispatchContext,
  DispatchResult,
  ModelCapability,
} from '@orchestral/core'

import {
  type AdapterOptions,
  asRecord,
  buildRecord,
  dispatchEnvelope,
  mintAssetIds,
  optionalNumber,
  optionalString,
  providerOptionsFor,
  requireString,
  resolveIdentity,
} from './envelope'

/**
 * A resolved AI SDK speech model OBJECT — `SpeechModel` minus the bare-id
 * string form. Build one with `openai.speech('tts-1')` (or any provider's
 * `.speech()`).
 */
export type SpeechModelInstance = Exclude<SpeechModel, string>

/**
 * Wrap an AI SDK speech model as a `text-to-speech` `ModelCapability`.
 *
 * Reads off the input: `text` (required), the AI SDK's own shared speech
 * fields when present on the top level — `voice`, `outputFormat`,
 * `instructions`, `speed`, `language` — plus a flat `providerOptions`.
 * Returns a `TextToSpeechOutput`: one `assets[]` element, its `assetId` from
 * `options.mintAssetId` (a placeholder by default; no `url` — the bytes
 * arrive as `artifacts` and on the `job:artifact` event, stamped with the
 * same id on `meta.assetId`), `cost: null`. `audioDurationMs` is omitted —
 * the SDK does not report it.
 *
 * Not mapped: the `voiceClone` asset slot (see README).
 */
export function fromSpeechModel(
  model: SpeechModelInstance,
  options: AdapterOptions = {},
): ModelCapability {
  const identity = resolveIdentity(model, options)
  return {
    ...buildRecord(identity, options, {
      capability: 'text-to-speech',
      inputs: ['text'],
      outputs: ['audio'],
    }),
    async call<I, O>(
      input: I,
      ctx: DispatchContext,
      events?: CallEvents,
    ): Promise<DispatchResult<O>> {
      const fields = asRecord(input)
      const text = requireString(fields, 'text', 'text-to-speech')
      const voice = optionalString(fields, 'voice')
      const outputFormat = optionalString(fields, 'outputFormat')
      const instructions = optionalString(fields, 'instructions')
      const language = optionalString(fields, 'language')
      const speed = optionalNumber(fields, 'speed')
      const providerOptions = providerOptionsFor(identity.provider, ctx, fields)

      const startedAt = Date.now()
      const { audio } = await generateSpeech({
        model,
        text,
        ...(voice !== undefined ? { voice } : {}),
        ...(outputFormat !== undefined ? { outputFormat } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: ctx.signal,
      })

      if (audio.base64.length === 0) {
        throw new Error(
          `${identity.provider}: the AI SDK speech model returned no audio`,
        )
      }

      const mime = audio.mediaType || 'audio/mpeg'
      const artifact: Artifact = {
        kind: 'audio',
        uri: `data:${mime};base64,${audio.base64}`,
        mime,
        meta: { format: audio.format },
      }
      const minted = mintAssetIds(
        [artifact],
        ctx,
        events,
        options,
        'text-to-speech',
        () => 'aisdk-audio-0',
      )

      // `url` deliberately unset — see fromImageModel for why the bytes ride
      // on `artifacts` / `job:artifact` rather than in the bounded output.
      const output = {
        modality: 'audio' as const,
        assets: minted.map(({ assetId }) => ({
          assetId,
          modality: 'audio' as const,
        })),
        ...dispatchEnvelope(identity, startedAt),
      }
      return { output: output as O, artifacts: minted.map((m) => m.artifact) }
    },
  }
}
