// fromImageModel — the envelope record, the generateImage call shape, and an
// output that parses against the first-party TextToImageOutputSchema. The
// model is ai/test's MockImageModelV3, so nothing leaves the process.

import { describe, expect, it, vi } from 'vitest'
import { MockImageModelV3, MockImageModelV4 } from 'ai/test'
import {
  MODEL_SPEC_VERSION,
  type Artifact,
  type DispatchContext,
} from '@orchestral/core'
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

  it('defaults assetId to the aisdk-image-<i> placeholder, and stamps it on each artifact', async () => {
    const onArtifact = vi.fn<(artifact: Artifact) => void>()
    const { output, artifacts } = await fromImageModel(mockImageModel()).call(
      { prompt: 'x', n: 2 },
      ctx(),
      { onArtifact },
    )
    const parsed = TextToImageOutputSchema.parse(output)
    expect(parsed.assets.map((a) => a.assetId)).toEqual(['aisdk-image-0', 'aisdk-image-1'])
    // The artifact says which output element it is, whoever minted the id.
    expect(artifacts!.map((a) => a.meta)).toEqual([
      { assetId: 'aisdk-image-0' },
      { assetId: 'aisdk-image-1' },
    ])
    expect(onArtifact.mock.calls.map(([a]) => a.meta?.assetId)).toEqual([
      'aisdk-image-0',
      'aisdk-image-1',
    ])
  })

  it('calls mintAssetId once per image, in order, with (artifact, index, ctx), and puts its answer on the output', async () => {
    const mintAssetId = vi.fn<
      (artifact: Artifact, index: number, ctx: DispatchContext) => string
    >((_artifact, index) => `img-${index + 1}`)
    const envelope = fromImageModel(mockImageModel(), { mintAssetId })
    const context = ctx()

    const { output, artifacts } = await envelope.call({ prompt: 'x', n: 2 }, context)

    expect(mintAssetId).toHaveBeenCalledTimes(2)
    for (const [i, [artifact, index, passedCtx]] of mintAssetId.mock.calls.entries()) {
      expect(index).toBe(i)
      expect(passedCtx).toBe(context)
      // The hook sees the bare artifact — bytes and mime, no id yet: the id
      // is what it is being asked for.
      expect(artifact).toEqual({
        kind: 'image',
        uri: `data:image/png;base64,${PNG_B64}`,
        mime: 'image/png',
      })
    }
    const parsed = TextToImageOutputSchema.parse(output)
    expect(parsed.assets.map((a) => a.assetId)).toEqual(['img-1', 'img-2'])
    expect(artifacts!.map((a) => a.meta?.assetId)).toEqual(['img-1', 'img-2'])
  })

  it('fires onArtifact after minting, with the minted id on meta.assetId, so the event and the output agree', async () => {
    const order: string[] = []
    const mintAssetId = vi.fn<
      (artifact: Artifact, index: number, ctx: DispatchContext) => string
    >((_artifact, index) => {
      order.push(`mint:${index}`)
      return `stored-${index}`
    })
    const onArtifact = vi.fn<(artifact: Artifact) => void>((artifact) => {
      order.push(`artifact:${String(artifact.meta?.assetId)}`)
    })

    const { output } = await fromImageModel(mockImageModel(), { mintAssetId }).call(
      { prompt: 'x', n: 2 },
      ctx(),
      { onArtifact },
    )

    // Every id is minted before the first event fires: a host that keys its
    // store from `job:artifact` sees the id the output will carry.
    expect(order).toEqual(['mint:0', 'mint:1', 'artifact:stored-0', 'artifact:stored-1'])
    const parsed = TextToImageOutputSchema.parse(output)
    expect(onArtifact.mock.calls.map(([a]) => a.meta?.assetId)).toEqual(
      parsed.assets.map((a) => a.assetId),
    )
  })

  it('fails with MINT_ASSET_ID_INVALID on an empty, over-long or non-string id, firing no artifact event', async () => {
    const onArtifact = vi.fn<(artifact: Artifact) => void>()
    const attempt = (id: unknown) =>
      fromImageModel(mockImageModel(), { mintAssetId: () => id as string }).call(
        { prompt: 'x' },
        ctx(),
        { onArtifact },
      )

    await expect(attempt('')).rejects.toMatchObject({
      code: 'MINT_ASSET_ID_INVALID',
      message: expect.stringContaining(
        'MINT_ASSET_ID_INVALID: text-to-image call: mintAssetId returned an empty string for artifact 0',
      ),
    })
    await expect(attempt('x'.repeat(200))).rejects.toMatchObject({
      code: 'MINT_ASSET_ID_INVALID',
      message: expect.stringContaining('a 200-character string'),
    })
    // A JS host that forgot a `return` — the type says string, the runtime
    // check is what catches it.
    await expect(attempt(undefined)).rejects.toMatchObject({
      code: 'MINT_ASSET_ID_INVALID',
      message: expect.stringContaining('returned undefined for artifact 0'),
    })
    // Minted before fired: a bad id for the SECOND image means no event for
    // the first either — nothing is announced that the output will not name.
    await expect(
      fromImageModel(mockImageModel(), {
        mintAssetId: (_artifact, index) => (index === 0 ? 'ok' : ''),
      }).call({ prompt: 'x', n: 2 }, ctx(), { onArtifact }),
    ).rejects.toMatchObject({ code: 'MINT_ASSET_ID_INVALID' })
    expect(onArtifact).not.toHaveBeenCalled()

    // The bound is assetIdField()'s: 128 is the last length that passes.
    const { output } = await attempt('y'.repeat(128))
    expect(TextToImageOutputSchema.parse(output).assets[0]!.assetId).toHaveLength(128)
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

  it('nests per-call providerOptions under the SDK provider key, not the routing identity', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => ({
      images: [PNG_B64],
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }))
    // A real AI SDK image model reports a sub-namespaced provider string; the
    // key `providerOptions` has to match is its first segment.
    const model = new MockImageModelV3({
      provider: 'openai.image',
      modelId: 'gpt-image-1',
      doGenerate,
    })
    const envelope = fromImageModel(model, {
      provider: 'relay',
      modelId: 'relay:gpt-image-1',
    })

    // The record keeps the catalog identity — that is what excludeModel /
    // pinnedModel match on.
    expect(envelope.provider).toBe('relay')
    expect(envelope.modelId).toBe('relay:gpt-image-1')

    await envelope.call(
      { prompt: 'x', providerOptions: { quality: 'high' } },
      ctx({ providerOptions: { openai: { style: 'vivid' } } }),
    )

    // Under the relay slug these options would have reached the provider
    // unread: the SDK takes the key it knows and says nothing about the rest.
    expect(doGenerate.mock.calls[0]![0].providerOptions).toEqual({
      openai: { style: 'vivid', quality: 'high' },
    })
  })

  it('lets sdkProviderKey state the wire key when the first segment is wrong', async () => {
    const doGenerate = vi.fn<DoGenerate>(async () => ({
      images: [PNG_B64],
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
    }))
    const envelope = fromImageModel(mockImageModel(doGenerate), {
      provider: 'relay',
      sdkProviderKey: 'fal',
    })

    await envelope.call({ prompt: 'x', providerOptions: { seed: 1 } }, ctx())

    expect(doGenerate.mock.calls[0]![0].providerOptions).toEqual({ fal: { seed: 1 } })
    expect(envelope.provider).toBe('relay')
  })
})
