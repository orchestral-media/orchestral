// fromTranscriptionModel — the `source` asset is read off ctx.assets and
// loaded through the host's `loadAudio`; the output parses against the
// first-party AutomaticSpeechRecognitionOutputSchema.

import { describe, expect, it, vi } from 'vitest'
import { MockTranscriptionModelV3 } from 'ai/test'
import {
  MODEL_SPEC_VERSION,
  type DispatchContext,
  type ResolvedAssetRef,
} from '@orchestral/core'
import { AutomaticSpeechRecognitionOutputSchema } from '@orchestral/patterns'

import { fromTranscriptionModel, type AudioSource } from '../transcription'

type DoGenerate = MockTranscriptionModelV3['doGenerate']

const AUDIO = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2])

const SOURCE: ResolvedAssetRef = {
  slot: 'source',
  assetId: 'asset-42',
  modality: 'audio',
  handle: 'audio_1',
}

function transcript(): Awaited<ReturnType<DoGenerate>> {
  return {
    text: 'hello world',
    segments: [
      { text: 'hello', startSecond: 0, endSecond: 0.4 },
      { text: 'world', startSecond: 0.5, endSecond: 1.1 },
    ],
    language: 'en',
    durationInSeconds: 1.25,
    warnings: [],
    response: { timestamp: new Date(0), modelId: 'whisper-1', headers: {} },
  }
}

function mockTranscriptionModel(
  doGenerate: DoGenerate = async () => transcript(),
): MockTranscriptionModelV3 {
  return new MockTranscriptionModelV3({
    provider: 'openai',
    modelId: 'whisper-1',
    doGenerate,
  })
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { signal: new AbortController().signal, assets: [SOURCE], ...overrides }
}

describe('fromTranscriptionModel', () => {
  it('declares an automatic-speech-recognition envelope from the model identity', () => {
    const envelope = fromTranscriptionModel(mockTranscriptionModel(), {
      loadAudio: () => AUDIO,
    })
    expect(envelope.specificationVersion).toBe(MODEL_SPEC_VERSION)
    expect(envelope.capabilities).toEqual(['automatic-speech-recognition'])
    expect(envelope.provider).toBe('openai')
    expect(envelope.modelId).toBe('whisper-1')
    expect(envelope.inputs).toEqual(['audio'])
    expect(envelope.outputs).toEqual(['text'])
    expect(envelope.source).toBe('user')
  })

  it('loads the source asset through the host loader and returns a schema-valid output', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => transcript())
    const loadAudio = vi.fn<(ref: ResolvedAssetRef, ctx: DispatchContext) => AudioSource>(
      () => AUDIO,
    )
    const envelope = fromTranscriptionModel(mockTranscriptionModel(doGenerate), {
      loadAudio,
    })
    const context = ctx({ providerOptions: { openai: { temperature: 0 } } })

    const { output } = await envelope.call(
      { providerOptions: { language: 'en' } },
      context,
    )

    // The loader saw the resolved ref and the dispatch context.
    expect(loadAudio).toHaveBeenCalledTimes(1)
    expect(loadAudio.mock.calls[0]![0]).toBe(SOURCE)
    expect(loadAudio.mock.calls[0]![1]).toBe(context)

    // The SDK got the bytes, a sniffed-or-default media type, the merged
    // providerOptions and the abort signal.
    const call = doGenerate.mock.calls[0]![0]
    expect(call.audio).toEqual(AUDIO)
    expect(typeof call.mediaType).toBe('string')
    expect(call.providerOptions).toEqual({
      openai: { temperature: 0, language: 'en' },
    })
    expect(call.abortSignal).toBe(context.signal)

    const parsed = AutomaticSpeechRecognitionOutputSchema.parse(output)
    expect(parsed.modality).toBe('text')
    expect(parsed.text).toBe('hello world')
    expect(parsed.segments).toEqual([
      { startSecond: 0, endSecond: 0.4, text: 'hello' },
      { startSecond: 0.5, endSecond: 1.1, text: 'world' },
    ])
    expect(parsed.words).toBeUndefined()
    expect(parsed.language).toBe('en')
    expect(parsed.audioDurationMs).toBe(1250)
    expect(parsed.model).toBe('openai:whisper-1')
    expect(parsed.provider).toBe('openai')
    expect(parsed.cost).toBeNull()
  })

  it('omits segments / language / audioDurationMs the provider did not report', async () => {
    const envelope = fromTranscriptionModel(
      mockTranscriptionModel(async () => ({
        ...transcript(),
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
      })),
      { loadAudio: () => AUDIO },
    )
    const { output } = await envelope.call({}, ctx())
    const parsed = AutomaticSpeechRecognitionOutputSchema.parse(output)
    expect(parsed.text).toBe('hello world')
    expect(parsed.segments).toBeUndefined()
    expect(parsed.language).toBeUndefined()
    expect(parsed.audioDurationMs).toBeUndefined()
  })

  it('accepts a URL from the loader and lets the SDK fetch it', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => transcript())
    const envelope = fromTranscriptionModel(mockTranscriptionModel(doGenerate), {
      // A data: URI — what a standalone host's text-to-speech output carries.
      loadAudio: async () =>
        new URL(`data:audio/wav;base64,${Buffer.from(AUDIO).toString('base64')}`),
    })
    await envelope.call({}, ctx())
    expect(doGenerate.mock.calls[0]![0].audio).toEqual(AUDIO)
  })

  it('fails before loading when no source asset was resolved', async () => {
    const loadAudio = vi.fn(() => AUDIO)
    const envelope = fromTranscriptionModel(mockTranscriptionModel(), { loadAudio })

    await expect(envelope.call({}, ctx({ assets: [] }))).rejects.toThrow(
      'no resolved asset in slot "source"',
    )
    await expect(envelope.call({}, ctx({ assets: undefined }))).rejects.toThrow(
      'no resolved asset in slot "source"',
    )
    expect(loadAudio).not.toHaveBeenCalled()
  })
})
