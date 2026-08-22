// fromVisionModel — every `source` asset on ctx.assets goes through the host's
// `loadImage` and up as a `file` part, in order, ahead of the prompt text; the
// output parses against the first-party ImageToTextOutputSchema.

import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import {
  MODEL_SPEC_VERSION,
  type DispatchContext,
  type ResolvedAssetRef,
} from '@orchestral/core'
import { ImageToTextOutputSchema } from '@orchestral/patterns'
import { z } from 'zod'

import { fromVisionModel, type ImageSource } from '../vision'

type DoGenerate = MockLanguageModelV3['doGenerate']
type GenerateResult = Awaited<ReturnType<DoGenerate>>

// A real 1x1 PNG, so the SDK's media-type sniffing has something to read.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = new Uint8Array(Buffer.from(PNG_B64, 'base64'))

const CAPTION = 'a red bicycle against a brick wall'

function source(assetId: string): ResolvedAssetRef {
  return { slot: 'source', assetId, modality: 'image', handle: assetId }
}

function reply(text: string, overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 12, text: 12, reasoning: 0 },
    },
    warnings: [],
    ...overrides,
  }
}

function mockVisionModel(
  doGenerate: DoGenerate = async () => reply(CAPTION),
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'openai',
    modelId: 'gpt-4o',
    doGenerate,
  })
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    signal: new AbortController().signal,
    assets: [source('asset-1')],
    ...overrides,
  }
}

/** The user message the mock recorded, split into its file and text parts. */
function userParts(model: MockLanguageModelV3, call = 0) {
  const prompt = model.doGenerateCalls[call]!.prompt
  const system = prompt.find((m) => m.role === 'system')
  const user = prompt.find((m) => m.role === 'user')
  if (user?.role !== 'user') throw new Error('no user message recorded')
  return {
    system: system?.role === 'system' ? system.content : undefined,
    parts: user.content,
    files: user.content.filter((part) => part.type === 'file'),
    texts: user.content.filter((part) => part.type === 'text'),
  }
}

const loadBytes = () => PNG

describe('fromVisionModel', () => {
  it('declares an image-to-text envelope from the model identity', () => {
    const envelope = fromVisionModel(mockVisionModel(), { loadImage: loadBytes })
    expect(envelope.specificationVersion).toBe(MODEL_SPEC_VERSION)
    expect(envelope.capabilities).toEqual(['image-to-text'])
    expect(envelope.provider).toBe('openai')
    expect(envelope.modelId).toBe('gpt-4o')
    expect(envelope.inputs).toEqual(['image', 'text'])
    expect(envelope.outputs).toEqual(['text'])
    expect(envelope.source).toBe('user')
  })

  it('returns exactly the first-party output, with cost null', async () => {
    const envelope = fromVisionModel(mockVisionModel(), { loadImage: loadBytes })
    const { output } = await envelope.call({}, ctx())

    const parsed = ImageToTextOutputSchema.parse(output)
    expect(parsed.modality).toBe('text')
    expect(parsed.text).toBe(CAPTION)
    expect(parsed.model).toBe('openai:gpt-4o')
    expect(parsed.provider).toBe('openai')
    expect(parsed.cost).toBeNull()
    expect(Number.isInteger(parsed.latencyMs)).toBe(true)
    // No `usage` / `finishReason`: image-to-text's output does not declare
    // them, and the adapter adds nothing the schema does not name.
    expect(Object.keys(output as object).sort()).toEqual(
      ['cost', 'latencyMs', 'modality', 'model', 'provider', 'text'],
    )
  })

  it('sends one file part per source asset, in ctx.assets order, ahead of the prompt text', async () => {
    const model = mockVisionModel()
    const loadImage = vi.fn<(ref: ResolvedAssetRef, ctx: DispatchContext) => ImageSource>(
      (ref) => {
        switch (ref.assetId) {
          // The three forms a host can hand back: stated media type, bare
          // bytes the SDK sniffs, and a data: URL the SDK splits itself.
          case 'asset-1':
            return { data: PNG_B64, mediaType: 'image/png' }
          case 'asset-2':
            return PNG
          default:
            return new URL(`data:image/png;base64,${PNG_B64}`)
        }
      },
    )
    const envelope = fromVisionModel(model, { loadImage })
    const context = ctx({
      assets: [source('asset-1'), source('asset-2'), source('asset-3')],
    })

    await envelope.call({ prompt: 'Which is sharpest?' }, context)

    // The loader saw each resolved ref and the dispatch context, in order.
    expect(loadImage.mock.calls.map(([ref]) => ref.assetId)).toEqual([
      'asset-1',
      'asset-2',
      'asset-3',
    ])
    expect(loadImage.mock.calls[0]![1]).toBe(context)

    const { parts, files, texts } = userParts(model)
    expect(files).toHaveLength(3)
    expect(parts.slice(0, 3)).toEqual(files)
    expect(parts[3]).toEqual({ type: 'text', text: 'Which is sharpest?' })
    expect(texts).toHaveLength(1)
    for (const part of files) {
      expect(part).toMatchObject({ type: 'file', mediaType: 'image/png' })
    }
    expect(files[0]).toMatchObject({ data: { type: 'data', data: PNG_B64 } })
    expect(files[1]).toMatchObject({ data: { type: 'data', data: PNG } })
    expect(files[2]).toMatchObject({ data: { type: 'data', data: PNG_B64 } })
    expect(model.doGenerateCalls[0]!.abortSignal).toBe(context.signal)
  })

  it('fails with a coded message when no source was resolved, without calling the loader or the model', async () => {
    const loadImage = vi.fn(loadBytes)
    const model = mockVisionModel()
    const envelope = fromVisionModel(model, { loadImage })

    await expect(envelope.call({}, ctx({ assets: [] }))).rejects.toThrow(
      'NO_SOURCE_ASSET: image-to-text call: no resolved asset in slot "source"',
    )
    await expect(envelope.call({}, ctx({ assets: undefined }))).rejects.toThrow(
      'NO_SOURCE_ASSET',
    )
    // A resolved asset in some other slot is not a source either.
    await expect(
      envelope.call(
        {},
        ctx({ assets: [{ slot: 'reference', assetId: 'r', modality: 'image' }] }),
      ),
    ).rejects.toThrow('NO_SOURCE_ASSET')
    expect(loadImage).not.toHaveBeenCalled()
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('fails with a coded message naming the asset when the loader hands back nothing', async () => {
    const model = mockVisionModel()
    const envelope = fromVisionModel(model, {
      // A JS host that forgot a return — the type says ImageSource, the
      // runtime guard is what catches it.
      loadImage: (ref) =>
        (ref.assetId === 'asset-2' ? undefined : PNG) as unknown as ImageSource,
    })
    await expect(
      envelope.call({}, ctx({ assets: [source('asset-1'), source('asset-2')] })),
    ).rejects.toThrow(
      'SOURCE_ASSET_NOT_LOADED: image-to-text call: loadImage returned nothing for asset "asset-2" in slot "source"',
    )
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it("places system / prompt / mode the way the pattern's field descriptions say", async () => {
    const model = mockVisionModel()
    const envelope = fromVisionModel(model, { loadImage: loadBytes })

    // Neither: the mode default is the system text, the image goes up alone.
    await envelope.call({}, ctx())
    expect(userParts(model, 0).system).toBe('Write a one-line caption for the image.')
    expect(userParts(model, 0).texts).toEqual([])

    // A mode other than the default picks its own instruction.
    await envelope.call({ mode: 'extract-style' }, ctx())
    expect(userParts(model, 1).system).toContain('visual style')

    // Prompt only: it replaces the mode-default text; no system is sent.
    await envelope.call({ mode: 'describe', prompt: 'What art style is this?' }, ctx())
    expect(userParts(model, 2).system).toBeUndefined()
    expect(userParts(model, 2).texts).toEqual([
      { type: 'text', text: 'What art style is this?' },
    ])

    // System wins and mode is ignored; the prompt rides as the user text.
    await envelope.call(
      { mode: 'caption', system: 'You are a judge.', prompt: 'Score it.' },
      ctx(),
    )
    expect(userParts(model, 3).system).toBe('You are a judge.')
    expect(userParts(model, 3).texts).toEqual([{ type: 'text', text: 'Score it.' }])

    // System only: still no mode text anywhere.
    await envelope.call({ mode: 'describe', system: 'You are a judge.' }, ctx())
    expect(userParts(model, 4).system).toBe('You are a judge.')
    expect(userParts(model, 4).texts).toEqual([])

    await expect(envelope.call({ mode: 'ocr' }, ctx())).rejects.toThrow(
      'input.mode must be one of "caption", "describe", "judge", "extract-style" (got "ocr")',
    )
  })

  it('states maxLength to the model as an instruction in text mode, and never cuts the reply', async () => {
    const long = 'x'.repeat(300)
    const model = mockVisionModel(async () => reply(long))
    const envelope = fromVisionModel(model, { loadImage: loadBytes })

    const { output } = await envelope.call(
      { prompt: 'Describe it.', maxLength: 120 },
      ctx(),
    )
    expect(userParts(model, 0).texts).toEqual([
      { type: 'text', text: 'Describe it.\n\nKeep the answer under 120 characters.' },
    ])
    expect(ImageToTextOutputSchema.parse(output).text).toBe(long)

    // With no prompt the hint is the whole user text.
    await envelope.call({ maxLength: 40 }, ctx())
    expect(userParts(model, 1).texts).toEqual([
      { type: 'text', text: 'Keep the answer under 40 characters.' },
    ])
  })

  it('round-trips structured output and leaves maxLength out of a JSON request', async () => {
    const Verdict = z.object({ best_image_index: z.number().int().min(0), reason: z.string() })
    const schema = z.toJSONSchema(Verdict, { target: 'draft-2020-12' })
    const model = mockVisionModel(async () =>
      reply('{"best_image_index": 0, "reason": "only one"}'),
    )
    const envelope = fromVisionModel(model, { loadImage: loadBytes })

    const { output } = await envelope.call(
      {
        system: 'You are a judge.',
        prompt: 'Pick one.',
        maxLength: 100,
        responseFormat: 'json',
        jsonSchema: schema,
      },
      ctx(),
    )

    expect(model.doGenerateCalls[0]!.responseFormat).toEqual({ type: 'json', schema })
    expect(userParts(model).texts).toEqual([{ type: 'text', text: 'Pick one.' }])
    const parsed = ImageToTextOutputSchema.parse(output)
    expect(Verdict.parse(JSON.parse(parsed.text))).toEqual({
      best_image_index: 0,
      reason: 'only one',
    })

    await expect(
      fromVisionModel(
        mockVisionModel(async () => reply('{"best_image_index": -1, "reason": "x"}')),
        { loadImage: loadBytes },
      ).call({ responseFormat: 'json', jsonSchema: schema }, ctx()),
    ).rejects.toThrow('response did not match schema')
  })

  it('nests flat input providerOptions under the provider key, per-call winning', async () => {
    const model = mockVisionModel()
    const envelope = fromVisionModel(model, { loadImage: loadBytes })
    await envelope.call(
      { providerOptions: { detail: 'high' } },
      ctx({ providerOptions: { openai: { detail: 'low', store: true } } }),
    )
    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({
      openai: { detail: 'high', store: true },
    })

    await envelope.call({}, ctx())
    expect(model.doGenerateCalls[1]!.providerOptions).toBeUndefined()
  })
})
