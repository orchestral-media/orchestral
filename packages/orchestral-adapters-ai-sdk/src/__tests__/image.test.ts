// fromImageModel — the envelope record, the generateImage call shape, and an
// output that parses against the first-party TextToImageOutputSchema. The
// model is ai/test's MockImageModelV3, so nothing leaves the process.

import { describe, expect, it, vi } from 'vitest'
import { MockImageModelV3, MockImageModelV4 } from 'ai/test'
import { MODEL_SPEC_VERSION, type DispatchContext } from '@orchestral/core'
import { TextToImageOutputSchema } from '@orchestral/patterns'

import { fromImageModel } from '../image'

// The bytes are irrelevant to the mock (it echoes base64 back); what matters
// is that the SDK cannot sniff a media type from them, so the adapter's
// `image/png` default is what lands in the data URI.
const PNG_B64 = 'aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='

type DoGenerate = MockImageModelV3['doGenerate']

function mockImageModel(doGenerate?: DoGenerate): MockImageModelV3 {
  return new MockImageModelV3({
    provider: 'openai',
    modelId: 'gpt-image-1',
    doGenerate:
      doGenerate ??
      (async ({ n }) => ({
        images: Array.from({ length: n }, () => PNG_B64),
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
      })),
  })
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { signal: new AbortController().signal, ...overrides }
}

describe('fromImageModel', () => {
  it('declares a text-to-image envelope from the model identity', () => {
    const envelope = fromImageModel(mockImageModel())
    expect(envelope.specificationVersion).toBe(MODEL_SPEC_VERSION)
    expect(envelope.capabilities).toEqual(['text-to-image'])
    expect(envelope.provider).toBe('openai')
    expect(envelope.modelId).toBe('gpt-image-1')
    expect(envelope.inputs).toEqual(['text'])
    expect(envelope.outputs).toEqual(['image'])
    expect(envelope.tags).toEqual([])
    expect(envelope.source).toBe('user')
    expect(envelope.tier).toBeUndefined()
  })

  it('applies provider / modelId / tags / tier overrides', () => {
    const envelope = fromImageModel(mockImageModel(), {
      provider: 'relay',
      modelId: 'relay:gpt-image-1',
      tags: ['fast'],
      tier: 'fast',
    })
    expect(envelope.provider).toBe('relay')
    expect(envelope.modelId).toBe('relay:gpt-image-1')
    expect(envelope.tags).toEqual(['fast'])
    expect(envelope.tier).toBe('fast')
  })

  it('accepts every AI SDK image-model spec version the union names', () => {
    // Constructor args are all optional; nothing is called here, so this only
    // proves the parameter type admits a V4 instance alongside V3.
    const envelope = fromImageModel(new MockImageModelV4())
    expect(envelope.provider).toBe('mock-provider')
    expect(envelope.modelId).toBe('mock-model-id')
  })

  it('returns an output the first-party schema parses, with cost null', async () => {
    const envelope = fromImageModel(mockImageModel())
    const onArtifact = vi.fn()

    const { output, artifacts } = await envelope.call(
      { prompt: 'a red bicycle' },
      ctx(),
      { onArtifact },
    )

    const parsed = TextToImageOutputSchema.parse(output)
    expect(parsed.modality).toBe('image')
    expect(parsed.model).toBe('openai:gpt-image-1')
    expect(parsed.provider).toBe('openai')
    expect(parsed.cost).toBeNull()
    expect(Number.isInteger(parsed.latencyMs)).toBe(true)
    expect(parsed.assets).toHaveLength(1)
    expect(parsed.assets[0]!.modality).toBe('image')
    // `url` is deliberately unset: the bounded output is never the channel
    // for the bytes.
    expect(parsed.assets[0]!.url).toBeUndefined()

    // The bytes travel on the artifact channel only, and the event fired once
    // per image.
    expect(artifacts).toHaveLength(1)
    expect(artifacts![0]!.kind).toBe('image')
    expect(artifacts![0]!.uri).toMatch(/^data:image\/png;base64,/)
    expect(onArtifact).toHaveBeenCalledTimes(1)
  })

  it('passes the pattern generation params, merged providerOptions and the abort signal to the SDK', async () => {
    const doGenerate = vi.fn<DoGenerate>(async ({ n }) => ({
      images: Array.from({ length: n }, () => PNG_B64),
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }))
    const envelope = fromImageModel(mockImageModel(doGenerate))
    const context = ctx({
      providerOptions: { openai: { style: 'vivid', quality: 'low' } },
    })

    const { output } = await envelope.call(
      {
        prompt: 'a red bicycle',
        size: '1024x1024',
        aspectRatio: '1:1',
        n: 2,
        seed: 7,
        // Flat per-call options: nested under the provider key, and they win
        // over the host defaults for the same key.
        providerOptions: { quality: 'high' },
      },
      context,
    )

    // The mock caps one image per call, so n=2 is two SDK calls.
    expect(doGenerate).toHaveBeenCalledTimes(2)
    const first = doGenerate.mock.calls[0]![0]
    expect(first.prompt).toBe('a red bicycle')
    expect(first.size).toBe('1024x1024')
    expect(first.aspectRatio).toBe('1:1')
    expect(first.seed).toBe(7)
    expect(first.providerOptions).toEqual({
      openai: { style: 'vivid', quality: 'high' },
    })
    expect(first.abortSignal).toBe(context.signal)

    const parsed = TextToImageOutputSchema.parse(output)
    expect(parsed.assets).toHaveLength(2)
  })

  it('sends no providerOptions key when neither ctx nor input carries any', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => ({
      images: [PNG_B64],
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }))
    await fromImageModel(mockImageModel(doGenerate)).call({ prompt: 'x' }, ctx())
    // The SDK defaults an absent providerOptions to `{}` before the model call.
    expect(doGenerate.mock.calls[0]![0].providerOptions).toEqual({})
  })

  it('rejects a missing prompt and malformed size / aspectRatio before calling the SDK', async () => {
    const doGenerate = vi.fn<DoGenerate>()
    const envelope = fromImageModel(mockImageModel(doGenerate))

    await expect(envelope.call({}, ctx())).rejects.toThrow(
      'text-to-image call: input.prompt (non-empty string) is required',
    )
    await expect(
      envelope.call({ prompt: 'x', size: 'large' }, ctx()),
    ).rejects.toThrow('input.size must be "WIDTHxHEIGHT"')
    await expect(
      envelope.call({ prompt: 'x', aspectRatio: 'wide' }, ctx()),
    ).rejects.toThrow('input.aspectRatio must be "W:H"')
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it('lets the SDK\'s own error through when the model returns zero images', async () => {
    // generateImage throws NoImageGeneratedError itself on an empty result;
    // the adapter does not restate it.
    const envelope = fromImageModel(
      mockImageModel(async () => ({
        images: [],
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
      })),
    )
    await expect(envelope.call({ prompt: 'x' }, ctx())).rejects.toThrow(
      'No image generated.',
    )
  })

  it('fails loudly when every returned image has an empty payload', async () => {
    // A non-empty result the SDK accepts but that carries no bytes — the one
    // case the adapter's own guard exists for.
    const envelope = fromImageModel(
      mockImageModel(async () => ({
        images: [''],
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
      })),
    )
    await expect(envelope.call({ prompt: 'x' }, ctx())).rejects.toThrow(
      'openai: the AI SDK image model returned no images',
    )
  })
})
