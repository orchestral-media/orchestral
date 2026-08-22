// fromLanguageModel — the envelope record, the generateText call shape, the
// structured-output round trip, and an output that parses against the
// first-party TextGenerationOutputSchema. The model is ai/test's
// MockLanguageModelV3, so nothing leaves the process.

import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test'
import { MODEL_SPEC_VERSION, type DispatchContext } from '@orchestral/core'
import { TextGenerationOutputSchema } from '@orchestral/patterns'
import { z } from 'zod'

import { fromLanguageModel } from '../language'

type DoGenerate = MockLanguageModelV3['doGenerate']
type GenerateResult = Awaited<ReturnType<DoGenerate>>

function reply(
  text: string,
  overrides: Partial<GenerateResult> = {},
): GenerateResult {
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

function mockLanguageModel(
  doGenerate: DoGenerate = async () => reply('A red bicycle.'),
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    doGenerate,
  })
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { signal: new AbortController().signal, ...overrides }
}

// The shape a first-party meta hands over: a zod schema rendered by
// `toJsonSchemaCached` (draft-2020-12) into `jsonSchema`, and the same zod
// schema parsing `out.text` afterwards.
const JudgeSchema = z.object({
  best_image_index: z.number().int().min(0),
  reason: z.string().min(1),
})
const JUDGE_JSON_SCHEMA = z.toJSONSchema(JudgeSchema, { target: 'draft-2020-12' })

describe('fromLanguageModel', () => {
  it('declares a text-generation envelope from the model identity', () => {
    const envelope = fromLanguageModel(mockLanguageModel())
    expect(envelope.specificationVersion).toBe(MODEL_SPEC_VERSION)
    expect(envelope.capabilities).toEqual(['text-generation'])
    expect(envelope.provider).toBe('openai')
    expect(envelope.modelId).toBe('gpt-4o-mini')
    expect(envelope.inputs).toEqual(['text'])
    expect(envelope.outputs).toEqual(['text'])
    expect(envelope.tags).toEqual([])
    expect(envelope.source).toBe('user')
    expect(envelope.tier).toBeUndefined()
  })

  it('applies provider / modelId / tags / tier overrides', () => {
    const envelope = fromLanguageModel(mockLanguageModel(), {
      provider: 'relay',
      modelId: 'relay:gpt-4o-mini',
      tags: ['fast'],
      tier: 'fast',
    })
    expect(envelope.provider).toBe('relay')
    expect(envelope.modelId).toBe('relay:gpt-4o-mini')
    expect(envelope.tags).toEqual(['fast'])
    expect(envelope.tier).toBe('fast')
  })

  it('accepts every AI SDK language-model spec version the union names', () => {
    // Nothing is called here; this only proves the parameter type admits a
    // V4 instance alongside V3.
    const model = new MockLanguageModelV4()
    const envelope = fromLanguageModel(model)
    expect(envelope.provider).toBe(model.provider)
    expect(envelope.modelId).toBe(model.modelId)
  })

  it('returns an output the first-party schema parses, with cost null', async () => {
    const envelope = fromLanguageModel(mockLanguageModel())

    const { output } = await envelope.call({ prompt: 'Name a thing.' }, ctx())

    const parsed = TextGenerationOutputSchema.parse(output)
    expect(parsed.modality).toBe('text')
    expect(parsed.text).toBe('A red bicycle.')
    expect(parsed.model).toBe('openai:gpt-4o-mini')
    expect(parsed.provider).toBe('openai')
    expect(parsed.cost).toBeNull()
    expect(Number.isInteger(parsed.latencyMs)).toBe(true)
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 12 })
    expect(parsed.finishReason).toBe('stop')
  })

  it('passes prompt, system, the sampling fields, merged providerOptions and the abort signal to the SDK', async () => {
    const model = mockLanguageModel()
    const envelope = fromLanguageModel(model)
    const context = ctx({
      providerOptions: { openai: { reasoningEffort: 'low', store: true } },
    })

    await envelope.call(
      {
        prompt: 'Name a thing.',
        system: 'Be terse.',
        maxOutputTokens: 64,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
        // Flat per-call options: nested under the provider key, and they win
        // over the host defaults for the same key.
        providerOptions: { store: false },
      },
      context,
    )

    expect(model.doGenerateCalls).toHaveLength(1)
    const call = model.doGenerateCalls[0]!
    expect(call.prompt).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'Name a thing.' }] },
    ])
    expect(call.maxOutputTokens).toBe(64)
    expect(call.temperature).toBe(0.2)
    expect(call.topP).toBe(0.9)
    expect(call.topK).toBe(40)
    expect(call.stopSequences).toEqual(['END'])
    expect(call.providerOptions).toEqual({
      openai: { reasoningEffort: 'low', store: false },
    })
    expect(call.abortSignal).toBe(context.signal)
    // Text mode: no response format at all, the same call a plain
    // `generateText({ prompt })` makes.
    expect(call.responseFormat).toBeUndefined()
  })

  it('sends no providerOptions and no sampling fields when the input carries none', async () => {
    const model = mockLanguageModel()
    await fromLanguageModel(model).call({ prompt: 'x' }, ctx())
    const call = model.doGenerateCalls[0]!
    expect(call.providerOptions).toBeUndefined()
    expect(call.prompt).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
    ])
    expect(call.maxOutputTokens).toBeUndefined()
    expect(call.temperature).toBeUndefined()
    expect(call.stopSequences).toBeUndefined()
  })

  it('omits usage the provider did not report and maps every finish reason onto the pattern enum', async () => {
    const unreported = fromLanguageModel(
      mockLanguageModel(async () =>
        reply('x', {
          usage: {
            inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 12, text: 12, reasoning: 0 },
          },
          finishReason: { unified: 'content-filter', raw: 'content_filter' },
        }),
      ),
    )
    const first = TextGenerationOutputSchema.parse(
      (await unreported.call({ prompt: 'x' }, ctx())).output,
    )
    expect(first.usage).toBeUndefined()
    expect(first.finishReason).toBe('content_filter')

    const errored = fromLanguageModel(
      mockLanguageModel(async () =>
        reply('x', { finishReason: { unified: 'error', raw: 'boom' } }),
      ),
    )
    const second = TextGenerationOutputSchema.parse(
      (await errored.call({ prompt: 'x' }, ctx())).output,
    )
    // The pattern has no `error` member; the SDK's lands on `other`.
    expect(second.finishReason).toBe('other')
  })

  it('round-trips structured output: the caller JSON Schema goes to the provider, the validated object comes back as text', async () => {
    const model = mockLanguageModel(async () =>
      reply('{ "best_image_index": 1,\n "reason": "sharper" }'),
    )
    const envelope = fromLanguageModel(model)

    const { output } = await envelope.call(
      {
        prompt: 'Pick the best.',
        responseFormat: 'json',
        jsonSchema: JUDGE_JSON_SCHEMA,
      },
      ctx(),
    )

    // The provider saw the schema as its JSON response format.
    expect(model.doGenerateCalls[0]!.responseFormat).toEqual({
      type: 'json',
      schema: JUDGE_JSON_SCHEMA,
    })
    // `text` is the validated object — the thing a meta `JSON.parse`s.
    const parsed = TextGenerationOutputSchema.parse(output)
    expect(JudgeSchema.parse(JSON.parse(parsed.text))).toEqual({
      best_image_index: 1,
      reason: 'sharper',
    })
    expect(parsed.text).toBe('{"best_image_index":1,"reason":"sharper"}')
  })

  it('asks for JSON without a schema when none is given', async () => {
    const model = mockLanguageModel(async () => reply('[1, 2, 3]'))
    const { output } = await fromLanguageModel(model).call(
      { prompt: 'List three numbers.', responseFormat: 'json' },
      ctx(),
    )
    expect(model.doGenerateCalls[0]!.responseFormat).toEqual({ type: 'json' })
    expect(TextGenerationOutputSchema.parse(output).text).toBe('[1,2,3]')
  })

  it('fails the call when the JSON reply does not match the schema, does not parse, or was cut off', async () => {
    const input = {
      prompt: 'Pick the best.',
      responseFormat: 'json',
      jsonSchema: JUDGE_JSON_SCHEMA,
    }

    await expect(
      fromLanguageModel(
        mockLanguageModel(async () => reply('{"best_image_index":"one","reason":"x"}')),
      ).call(input, ctx()),
    ).rejects.toThrow('response did not match schema')

    await expect(
      fromLanguageModel(
        mockLanguageModel(async () => reply('not json at all')),
      ).call(input, ctx()),
    ).rejects.toThrow('could not parse the response')

    // A `length` finish never reaches the parser; reading the object fails
    // instead of handing the caller half a document.
    await expect(
      fromLanguageModel(
        mockLanguageModel(async () =>
          reply('{"best_image_index":1,', {
            finishReason: { unified: 'length', raw: 'length' },
          }),
        ),
      ).call(input, ctx()),
    ).rejects.toThrow('No output generated')
  })

  it('reads jsonSchema only alongside responseFormat json, and rejects a malformed pair before calling the model', async () => {
    const model = mockLanguageModel()
    const envelope = fromLanguageModel(model)

    // Text mode with a stray schema: the schema is ignored, the text is raw.
    const { output } = await envelope.call(
      { prompt: 'x', jsonSchema: JUDGE_JSON_SCHEMA },
      ctx(),
    )
    expect(model.doGenerateCalls[0]!.responseFormat).toBeUndefined()
    expect(TextGenerationOutputSchema.parse(output).text).toBe('A red bicycle.')

    await expect(
      envelope.call({ prompt: 'x', responseFormat: 'xml' }, ctx()),
    ).rejects.toThrow('input.responseFormat must be "text" or "json"')
    await expect(
      envelope.call({ prompt: 'x', responseFormat: 'json', jsonSchema: 'object' }, ctx()),
    ).rejects.toThrow('input.jsonSchema must be a JSON Schema object')
    await expect(
      envelope.call(
        {
          prompt: 'x',
          responseFormat: 'json',
          jsonSchema: { type: 'object', if: { type: 'string' } },
        },
        ctx(),
      ),
    ).rejects.toThrow('input.jsonSchema cannot be compiled for validation')
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  it('rejects a missing prompt before calling the SDK', async () => {
    const doGenerate = vi.fn<DoGenerate>()
    const envelope = fromLanguageModel(mockLanguageModel(doGenerate))
    await expect(envelope.call({}, ctx())).rejects.toThrow(
      'text-generation call: input.prompt (non-empty string) is required',
    )
    expect(doGenerate).not.toHaveBeenCalled()
  })
})
