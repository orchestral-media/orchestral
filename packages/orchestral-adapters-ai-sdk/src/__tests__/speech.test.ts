// fromSpeechModel — envelope record, generateSpeech call shape, and an output
// that parses against the first-party TextToSpeechOutputSchema.

import { describe, expect, it, vi } from 'vitest'
import { MockSpeechModelV3 } from 'ai/test'
import {
  MODEL_SPEC_VERSION,
  type Artifact,
  type DispatchContext,
} from '@orchestral/core'
import { TextToSpeechOutputSchema } from '@orchestral/patterns'

import { fromSpeechModel } from '../speech'

type DoGenerate = MockSpeechModelV3['doGenerate']

// Arbitrary bytes: the SDK cannot sniff a media type from them, so the data
// URI carries the SDK's own audio fallback type.
const AUDIO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

function mockSpeechModel(doGenerate?: DoGenerate): MockSpeechModelV3 {
  return new MockSpeechModelV3({
    provider: 'openai',
    modelId: 'tts-1',
    doGenerate:
      doGenerate ??
      (async () => ({
        audio: AUDIO,
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'tts-1', headers: {} },
      })),
  })
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { signal: new AbortController().signal, ...overrides }
}

describe('fromSpeechModel', () => {
  it('declares a text-to-speech envelope from the model identity', () => {
    const envelope = fromSpeechModel(mockSpeechModel(), { tags: ['fast'] })
    expect(envelope.specificationVersion).toBe(MODEL_SPEC_VERSION)
    expect(envelope.capabilities).toEqual(['text-to-speech'])
    expect(envelope.provider).toBe('openai')
    expect(envelope.modelId).toBe('tts-1')
    expect(envelope.inputs).toEqual(['text'])
    expect(envelope.outputs).toEqual(['audio'])
    expect(envelope.tags).toEqual(['fast'])
    expect(envelope.source).toBe('user')
  })

  it('returns an output the first-party schema parses, with cost null', async () => {
    const envelope = fromSpeechModel(mockSpeechModel())
    const onArtifact = vi.fn()

    const { output, artifacts } = await envelope.call(
      { text: 'hello from orchestral' },
      ctx(),
      { onArtifact },
    )

    const parsed = TextToSpeechOutputSchema.parse(output)
    expect(parsed.modality).toBe('audio')
    expect(parsed.model).toBe('openai:tts-1')
    expect(parsed.provider).toBe('openai')
    expect(parsed.cost).toBeNull()
    expect(parsed.audioDurationMs).toBeUndefined()
    expect(parsed.assets).toHaveLength(1)
    expect(parsed.assets[0]!.modality).toBe('audio')
    expect(parsed.assets[0]!.assetId).toBe('aisdk-audio-0')
    // `url` is deliberately unset: the bounded output is never the channel
    // for the bytes.
    expect(parsed.assets[0]!.url).toBeUndefined()

    expect(artifacts).toHaveLength(1)
    expect(artifacts![0]!.kind).toBe('audio')
    expect(artifacts![0]!.uri).toMatch(/^data:audio\/[\w.+-]+;base64,/)
    // The SDK's format, plus the id the output element carries.
    expect(artifacts![0]!.meta).toEqual({
      format: expect.any(String),
      assetId: 'aisdk-audio-0',
    })
    expect(onArtifact).toHaveBeenCalledTimes(1)
  })

  it('mints the assetId through mintAssetId — (artifact, 0, ctx) — and stamps it on the artifact before the event fires', async () => {
    const mintAssetId = vi.fn<
      (artifact: Artifact, index: number, ctx: DispatchContext) => string
    >(() => 'clip-7')
    const onArtifact = vi.fn<(artifact: Artifact) => void>()
    const context = ctx()

    const { output, artifacts } = await fromSpeechModel(mockSpeechModel(), {
      mintAssetId,
    }).call({ text: 'hello' }, context, { onArtifact })

    expect(mintAssetId).toHaveBeenCalledTimes(1)
    const [artifact, index, passedCtx] = mintAssetId.mock.calls[0]!
    expect(index).toBe(0)
    expect(passedCtx).toBe(context)
    // The hook sees the bare artifact — the SDK's format on meta, no id yet.
    expect(artifact.kind).toBe('audio')
    expect(artifact.uri).toMatch(/^data:audio\/[\w.+-]+;base64,/)
    expect(artifact.meta).toEqual({ format: expect.any(String) })

    const parsed = TextToSpeechOutputSchema.parse(output)
    expect(parsed.assets[0]!.assetId).toBe('clip-7')
    // Stamped alongside the format, not in place of it, and the event carries
    // the same artifact the result does.
    expect(artifacts![0]!.meta).toEqual({ format: expect.any(String), assetId: 'clip-7' })
    expect(onArtifact).toHaveBeenCalledTimes(1)
    expect(onArtifact.mock.calls[0]![0]).toBe(artifacts![0])
    expect(mintAssetId.mock.invocationCallOrder[0]).toBeLessThan(
      onArtifact.mock.invocationCallOrder[0]!,
    )
  })

  it('fails with MINT_ASSET_ID_INVALID on an empty or over-long id, firing no artifact event', async () => {
    const onArtifact = vi.fn<(artifact: Artifact) => void>()
    const attempt = (id: string) =>
      fromSpeechModel(mockSpeechModel(), { mintAssetId: () => id }).call(
        { text: 'hello' },
        ctx(),
        { onArtifact },
      )

    await expect(attempt('')).rejects.toMatchObject({
      code: 'MINT_ASSET_ID_INVALID',
      message: expect.stringContaining('text-to-speech call: mintAssetId returned an empty string'),
    })
    await expect(attempt('x'.repeat(200))).rejects.toMatchObject({
      code: 'MINT_ASSET_ID_INVALID',
    })
    expect(onArtifact).not.toHaveBeenCalled()
  })

  it('passes the shared speech fields, merged providerOptions and the abort signal to the SDK', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => ({
      audio: AUDIO,
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'tts-1', headers: {} },
    }))
    const envelope = fromSpeechModel(mockSpeechModel(doGenerate))
    const context = ctx({ providerOptions: { openai: { responseFormat: 'wav' } } })

    await envelope.call(
      {
        text: 'hello',
        voice: 'alloy',
        outputFormat: 'mp3',
        instructions: 'slowly',
        speed: 0.9,
        language: 'en',
        providerOptions: { speed: 1.2 },
      },
      context,
    )

    expect(doGenerate).toHaveBeenCalledTimes(1)
    const call = doGenerate.mock.calls[0]![0]
    expect(call.text).toBe('hello')
    expect(call.voice).toBe('alloy')
    expect(call.outputFormat).toBe('mp3')
    expect(call.instructions).toBe('slowly')
    expect(call.speed).toBe(0.9)
    expect(call.language).toBe('en')
    expect(call.providerOptions).toEqual({
      openai: { responseFormat: 'wav', speed: 1.2 },
    })
    expect(call.abortSignal).toBe(context.signal)
  })

  it('rejects a missing text before calling the SDK', async () => {
    const doGenerate = vi.fn<DoGenerate>()
    await expect(
      fromSpeechModel(mockSpeechModel(doGenerate)).call({ text: '' }, ctx()),
    ).rejects.toThrow('text-to-speech call: input.text (non-empty string) is required')
    expect(doGenerate).not.toHaveBeenCalled()
  })
})
