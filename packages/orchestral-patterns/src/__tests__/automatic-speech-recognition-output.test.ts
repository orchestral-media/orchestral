import { describe, expect, it } from 'vitest'

import { AutomaticSpeechRecognitionOutputSchema } from '../index'

// Regression guard against schema-vs-adapter drift on the timestamp fields.
//
// A transcription adapter emits segment/word timestamps as
// `{ startSecond, endSecond, text }` (seconds). Naming them `{ start, end }`
// in the declared schema instead is a SILENT failure: the atomic dispatch path
// returns `result.output` without running `outputs.parse()`, so an emitted
// object that does not satisfy its own contract reaches the caller unflagged.
//
// These tests pin the canonical shape: anything that flips a segment field
// back to `start`/`end` (or drops a required envelope field) fails here.

// A representative adapter output at the capability boundary for a
// segment-timestamped transcription.
const RUNTIME_OUTPUT = {
  modality: 'text',
  text: 'Love this product.',
  segments: [
    { startSecond: 0, endSecond: 1.5, text: 'Love this' },
    { startSecond: 1.5, endSecond: 3, text: 'product.' },
  ],
  cost: 0,
  latencyMs: 412,
  model: 'openai:whisper-1',
  provider: 'openai',
  audioDurationMs: 3000,
  language: 'en',
} as const

describe('AutomaticSpeechRecognitionOutputSchema', () => {
  it('accepts the runtime-emitted segment shape ({ startSecond, endSecond, text })', () => {
    const segment = { startSecond: 1.5, endSecond: 3, text: 'product.' }
    const parsed = AutomaticSpeechRecognitionOutputSchema.parse({
      modality: 'text',
      text: 'product.',
      segments: [segment],
      cost: 0,
      latencyMs: 0,
      model: 'openai:whisper-1',
      provider: 'openai',
    })
    expect(parsed.segments).toEqual([segment])
  })

  it('validates the full host-emitted output object', () => {
    const parsed = AutomaticSpeechRecognitionOutputSchema.parse(RUNTIME_OUTPUT)
    expect(parsed.segments?.[0]).toEqual({ startSecond: 0, endSecond: 1.5, text: 'Love this' })
    expect(parsed.audioDurationMs).toBe(3000)
  })

  it('rejects the legacy { start, end } segment shape', () => {
    // The old schema named these `start`/`end`. The object schema is non-strict
    // ($strip), so this throws because the required `startSecond`/`endSecond`
    // are ABSENT (the stray `start`/`end` keys are stripped, not forbidden) —
    // which is exactly the drift this PR fixes. If a future change re-admits
    // `start`/`end` as an optional compat shape, this guard fails.
    expect(() =>
      AutomaticSpeechRecognitionOutputSchema.parse({
        modality: 'text',
        text: 'Love this',
        segments: [{ start: 0, end: 1.5, text: 'Love this' }],
        cost: 0,
        latencyMs: 0,
        model: 'openai:whisper-1',
        provider: 'openai',
      }),
    ).toThrow()
  })

  it('declares word-level timestamps in the same { startSecond, endSecond } shape', () => {
    // Schema-shape only: `words` is a forward-looking field for adapters that
    // surface word granularity. This pins the schema's declared shape, not a
    // value any shipped adapter produces yet.
    const parsed = AutomaticSpeechRecognitionOutputSchema.parse({
      modality: 'text',
      text: 'hi there',
      words: [
        { startSecond: 0, endSecond: 0.4, text: 'hi' },
        { startSecond: 0.4, endSecond: 0.9, text: 'there' },
      ],
      cost: 0,
      latencyMs: 0,
      model: 'openai:whisper-1',
      provider: 'openai',
    })
    expect(parsed.words).toHaveLength(2)
    expect(parsed.words?.[0].startSecond).toBe(0)
  })
})
