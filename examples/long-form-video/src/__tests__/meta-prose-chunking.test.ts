import { describe, expect, it } from 'vitest'

import type { ExecutionContext, StepOptions, PatternRef } from '@orchestral/core'
import {
  createProseChunkingMeta,
  splitProseByTokenBudget,
} from '../patterns/prose-chunking'
import {
  NARRATIVE_COMPRESSION_PROMPT,
  NARRATIVE_AGGREGATION_PROMPT,
} from '../patterns/prose-chunking/prompts'

interface RecordedStep {
  patternId: string
  input: Record<string, unknown>
  stepOptions: StepOptions | undefined
}

/**
 * Fake ExecutionContext.
 *
 * - `compress` calls (system === NARRATIVE_COMPRESSION_PROMPT) return canned
 *   compressed text in submission order (each chunk gets `compressed-${i}`).
 * - The final aggregate call (system === NARRATIVE_AGGREGATION_PROMPT) returns
 *   a single combined string.
 *
 * We disambiguate compress vs aggregate by matching the inlined `system`
 * prompt against the real prompt constants the meta bakes in.
 */
function makeCtx(opts: { aggregateText: string; aggregateCost?: number }) {
  const recorded: RecordedStep[] = []
  let compressIdx = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      recorded.push({
        patternId: ref.patternId,
        input,
        stepOptions: options,
      })
      const sys = String(input.system)
      if (sys === NARRATIVE_COMPRESSION_PROMPT) {
        const text = `compressed-${compressIdx}`
        compressIdx++
        return {
          modality: 'text',
          text,
          cost: 1,
          latencyMs: 100,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      // NARRATIVE_AGGREGATION_PROMPT
      return {
        modality: 'text',
        text: opts.aggregateText,
        cost: opts.aggregateCost ?? 3,
        latencyMs: 200,
        model: 'm',
        provider: 'p',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, recorded }
}

describe('meta_prose-chunking', () => {
  it('runs 1 compress + 1 aggregate for prose smaller than the token budget', async () => {
    const meta = createProseChunkingMeta()
    const { ctx, recorded } = makeCtx({ aggregateText: 'stitched story' })

    const out = await meta.compose(
      {
        input: {
          prose: 'Short prose that fits in one chunk.',
          chunkTokenBudget: 8000, // > 35 chars / 4 → single chunk
        },
      },
      ctx,
    )

    expect(recorded).toHaveLength(2) // 1 compress + 1 aggregate
    expect(out.compressedChunks).toEqual(['compressed-0'])
    expect(out.aggregatedNarrative).toBe('stitched story')
    // cost = 1 compress + 3 aggregate. latency = max(100) + 200.
    expect(out.cost).toBe(4)
    expect(out.latencyMs).toBe(300)
  })

  it('keeps cost finite when the aggregate step reports NaN (sumCosts guard)', async () => {
    const meta = createProseChunkingMeta()
    const { ctx } = makeCtx({
      aggregateText: 'stitched story',
      aggregateCost: Number.NaN,
    })

    const out = await meta.compose(
      {
        input: {
          prose: 'Short prose that fits in one chunk.',
          chunkTokenBudget: 8000,
        },
      },
      ctx,
    )

    // The NaN aggregate cost is guarded to 0 — only the compress call (1)
    // counts instead of poisoning the total.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBe(1)
  })

  it('splits long prose into multiple chunks and uses unique stepId per chunk', async () => {
    const meta = createProseChunkingMeta()
    const { ctx, recorded } = makeCtx({ aggregateText: 'aggregated' })

    // ~12000 chars across 3 paragraphs → with chunkTokenBudget=1000 (4000
    // chars budget), expect ≈ 3 chunks.
    const para = 'X'.repeat(3500) // each para ~3500 chars
    const prose = [para, para, para].join('\n\n')

    await meta.compose(
      {
        input: {
          prose,
          chunkTokenBudget: 1000, // 4000-char budget → 3 chunks expected
        },
      },
      ctx,
    )

    const compressCalls = recorded.filter(
      (c) => String(c.input.system) === NARRATIVE_COMPRESSION_PROMPT,
    )
    expect(compressCalls.length).toBeGreaterThanOrEqual(2)
    // Each compress call carries a unique stepId — without override they'd
    // collapse onto a single stepCache entry and we'd only get one
    // compressed chunk.
    const stepIds = compressCalls.map((c) => c.stepOptions?.stepId)
    const uniqueIds = new Set(stepIds)
    expect(uniqueIds.size).toBe(compressCalls.length)
    expect(stepIds[0]).toBe('compress-0')
  })

  it('threads targetCompressionRatio into the compression prompt as a soft hint', async () => {
    const meta = createProseChunkingMeta()
    const { ctx, recorded } = makeCtx({ aggregateText: 'aggregated' })

    await meta.compose(
      {
        input: {
          prose: 'Short prose.',
          targetCompressionRatio: 0.3,
        },
      },
      ctx,
    )

    const compressCall = recorded.find(
      (c) => String(c.input.system) === NARRATIVE_COMPRESSION_PROMPT,
    )
    const prompt = String(compressCall!.input.prompt)
    expect(prompt).toContain('<NOVEL_CHUNK_START>')
    expect(prompt).toContain('Short prose.')
    expect(prompt).toContain('<NOVEL_CHUNK_END>')
    // Ratio hint rendered as "~30% of the original".
    expect(prompt).toContain('~30%')
  })

  it('omits the ratio hint when targetCompressionRatio is not provided', async () => {
    const meta = createProseChunkingMeta()
    const { ctx, recorded } = makeCtx({ aggregateText: 'aggregated' })

    await meta.compose({ input: { prose: 'Short.' } }, ctx)

    const compressCall = recorded.find(
      (c) => String(c.input.system) === NARRATIVE_COMPRESSION_PROMPT,
    )
    const prompt = String(compressCall!.input.prompt)
    expect(prompt).not.toContain('Compression target')
  })

  it('feeds the aggregation prompt as ordered <CHUNK_N_START> blocks', async () => {
    const meta = createProseChunkingMeta()
    const { ctx, recorded } = makeCtx({ aggregateText: 'stitched' })

    const para = 'Y'.repeat(2000)
    await meta.compose(
      {
        input: {
          prose: [para, para].join('\n\n'),
          chunkTokenBudget: 500, // 2000-char budget per chunk → exactly 2 chunks
        },
      },
      ctx,
    )

    const aggregateCall = recorded.find(
      (c) => String(c.input.system) === NARRATIVE_AGGREGATION_PROMPT,
    )
    const aggPrompt = String(aggregateCall!.input.prompt)
    expect(aggPrompt).toContain('<CHUNK_0_START>')
    expect(aggPrompt).toContain('compressed-0')
    expect(aggPrompt).toContain('<CHUNK_0_END>')
    expect(aggPrompt).toContain('<CHUNK_1_START>')
    expect(aggPrompt).toContain('compressed-1')
    expect(aggPrompt).toContain('<CHUNK_1_END>')
  })

  it('declares a meta Pattern with stable id, kind, and agent-tool exposure', () => {
    const meta = createProseChunkingMeta()
    expect(meta.id).toBe('meta_prose-chunking')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.exposure).toBe('agent-tool')
    expect(meta.tool.description).toBeTruthy()
  })
})

describe('splitProseByTokenBudget', () => {
  it('returns prose unchanged when shorter than budget', () => {
    expect(splitProseByTokenBudget('hello world', 100)).toEqual(['hello world'])
  })

  it('preserves paragraph boundaries when possible', () => {
    const para = 'A'.repeat(500)
    const prose = [para, para, para].join('\n\n')
    // budget = 200 tokens = 800 chars, just over one para
    const chunks = splitProseByTokenBudget(prose, 200)
    // With a tight budget and 500-char paragraphs that fit one-at-a-time
    // (since 500 < 800), expect each paragraph to be its own chunk.
    expect(chunks).toHaveLength(3)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800)
    }
  })

  it('falls back to sentence-boundary cut when a single paragraph exceeds the budget', () => {
    // One paragraph, several sentences, total > budget.
    const paragraph =
      ('This is a sentence. '.repeat(80)).trim() // 1600 chars, 80 sentences
    const chunks = splitProseByTokenBudget(paragraph, 100) // 400 char budget
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) {
      // Each chunk ≤ budget, with sentence boundaries preferred.
      expect(c.length).toBeLessThanOrEqual(400 + 100) // small slack for boundary search window
    }
  })

  it('hard-cuts when no sentence boundary exists inside the budget window', () => {
    // No punctuation at all → must fall back to hard cut at budget.
    const blob = 'Z'.repeat(2000)
    const chunks = splitProseByTokenBudget(blob, 100) // 400 char budget
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400)
    }
    // All Z chars preserved across joins (no characters lost).
    expect(chunks.join('').replace(/\s/g, '')).toBe(blob)
  })

  it('uses a tighter chars-per-token ratio for CJK prose to avoid silently exceeding context windows', () => {
    // 1000 Chinese chars. With token≈4 chars (Latin assumption) the
    // 200-token budget would compute a 800-char budget → single chunk.
    // With CJK-aware 1.5 chars/token it should compute a 300-char budget
    // → multiple chunks, none exceeding ~300 chars.
    const chineseBlob = '一'.repeat(1000)
    const chunks = splitProseByTokenBudget(chineseBlob, 200)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      // budget = 200 × 1.5 = 300 chars
      expect(c.length).toBeLessThanOrEqual(300)
    }
    // Char-conservative — no characters lost.
    expect(chunks.join('').replace(/\s/g, '')).toBe(chineseBlob)
  })

  it('blends English+CJK char budgets proportionally for mixed-script prose', () => {
    // 50% English (4 chars/tok) and 50% Chinese (1.5 chars/tok) blob.
    // The estimator should land at ~2.75 chars/tok, so a 100-token budget
    // gives ~275 chars per chunk.
    const half = 'A'.repeat(500) + '中'.repeat(500)
    const chunks = splitProseByTokenBudget(half, 100)
    // Should produce ≥ 3 chunks (1000 chars / ~275-char budget).
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) {
      // Within reasonable upper bound (Latin-only would be 400; CJK-only ~150).
      expect(c.length).toBeLessThanOrEqual(400)
    }
  })
})
