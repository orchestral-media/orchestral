import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'
import { createReferenceImageCascadeMeta } from '../meta/reference-image-cascade'
import {
  REFERENCE_IMAGE_PREFILTER_PROMPT,
  REFERENCE_IMAGE_MULTIMODAL_SELECT_PROMPT,
} from '../meta/reference-image-cascade/prompts'

/**
 * Pull the input-block tags a prompt body declares (backticked `<TAG>` /
 * `</TAG>` forms). Guards against prompt↔code tag drift: the SKILL body tells
 * the model which wrappers to read, so the dispatched user prompt must emit
 * exactly those.
 */
function declaredTags(prompt: string): string[] {
  const found = new Set<string>()
  for (const m of prompt.matchAll(/`<\/?([A-Z][A-Z_]*)>`/g)) found.add(m[1])
  return [...found]
}

function makeCtx(steps: ReadonlyArray<{ text: string; cost?: number }>) {
  const calls: Array<{ patternId: string; input: Record<string, unknown> }> = []
  let i = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({
        patternId: ref.patternId,
        input: ref.input as Record<string, unknown>,
      })
      const s = steps[i++]
      return {
        modality: 'text',
        text: s?.text ?? '',
        cost: s?.cost ?? 1,
        latencyMs: 5,
        model: 'test:model',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

function refsOf(input: Record<string, unknown>): string[] {
  return (input.references as { source: string[] }).source
}

describe("meta_reference-image-cascade (W-1')", () => {
  it('skips the prefilter for small candidate sets (< 8) and selects via the VLM', async () => {
    const meta = createReferenceImageCascadeMeta()
    const { ctx, calls } = makeCtx([
      { text: JSON.stringify({ ref_image_indices: [0, 2], text_prompt: 'use these' }) },
    ])
    const candidates = [
      { ref: 'h0', text: 'a' },
      { ref: 'h1', text: 'b' },
      { ref: 'h2', text: 'c' },
    ]

    const out = await meta.compose(
      { input: { frameDescription: 'a sunset', candidates } },
      ctx,
    )

    // Single dispatch — the text-only prefilter stage is skipped for < 8
    // candidates, so the only call is the multimodal VLM select.
    expect(calls).toHaveLength(1)
    expect(calls[0].patternId).toBe('image-to-text')
    expect(refsOf(calls[0].input)).toEqual(['h0', 'h1', 'h2'])
    expect(out.selectedRefs).toEqual(['h0', 'h2'])
    expect(out.textPrompt).toBe('use these')
    // Only the multimodal select ran (cost 1); latency is measured, non-negative.
    expect(out.cost).toBeCloseTo(1)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('prefilters large sets (≥ 8) before the multimodal select', async () => {
    const meta = createReferenceImageCascadeMeta()
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      ref: `h${i}`,
      text: `t${i}`,
    }))
    const { ctx, calls } = makeCtx([
      { text: JSON.stringify({ ref_image_indices: [0, 2, 5], text_prompt: '' }) },
      { text: JSON.stringify({ ref_image_indices: [2], text_prompt: 'final' }) },
    ])

    const out = await meta.compose(
      { input: { frameDescription: 'x', candidates } },
      ctx,
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].patternId).toBe('text-generation') // text-only prefilter
    expect(calls[1].patternId).toBe('image-to-text')
    // Stage 2 sees only the prefiltered subset [h0, h2, h5].
    expect(refsOf(calls[1].input)).toEqual(['h0', 'h2', 'h5'])
    // VLM picked index 2 of that subset → h5.
    expect(out.selectedRefs).toEqual(['h5'])
    expect(out.textPrompt).toBe('final')
    // Both the prefilter (cost 1) and the multimodal select (cost 1) ran.
    expect(out.cost).toBeCloseTo(2)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps the full set when the prefilter returns nothing usable', async () => {
    const meta = createReferenceImageCascadeMeta()
    const candidates = Array.from({ length: 9 }, (_, i) => ({
      ref: `h${i}`,
      text: `t${i}`,
    }))
    const { ctx, calls } = makeCtx([
      { text: 'garbage, not json' }, // prefilter fails → non-destructive
      { text: JSON.stringify({ ref_image_indices: [0], text_prompt: 'ok' }) },
    ])

    const out = await meta.compose(
      { input: { frameDescription: 'x', candidates } },
      ctx,
    )

    expect(refsOf(calls[1].input)).toHaveLength(9) // full set preserved
    expect(out.selectedRefs).toEqual(['h0'])
    // The prefilter call still happened (cost 1) even though it narrowed
    // nothing; the select adds another 1.
    expect(out.cost).toBeCloseTo(2)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps cost finite when the prefilter reports NaN (sumCosts guard)', async () => {
    const meta = createReferenceImageCascadeMeta()
    const candidates = Array.from({ length: 9 }, (_, i) => ({
      ref: `h${i}`,
      text: `t${i}`,
    }))
    const { ctx } = makeCtx([
      {
        text: JSON.stringify({ ref_image_indices: [0, 2], text_prompt: '' }),
        cost: Number.NaN, // buggy adapter on the prefilter step
      },
      { text: JSON.stringify({ ref_image_indices: [0], text_prompt: 'ok' }) },
    ])

    const out = await meta.compose(
      { input: { frameDescription: 'x', candidates } },
      ctx,
    )

    // The NaN prefilter cost is guarded to 0 — only the multimodal select
    // (1) counts instead of poisoning the total.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBeCloseTo(1)
  })

  it('throws REFERENCE_SELECTION_INVALID when stage 2 returns only out-of-range indices', async () => {
    const meta = createReferenceImageCascadeMeta()
    const candidates = [
      { ref: 'h0', text: 'a' },
      { ref: 'h1', text: 'b' },
    ]
    // Model hallucinated — returned indices 99 and 100, both syntactically
    // valid (non-negative integers, accepted by the Zod schema) but out of
    // range for a 2-candidate set. Should throw at the guard, not silently
    // produce `selectedRefs: []`. Negative indices are rejected upstream by
    // the schema's `z.number().int().min(0)` and never reach the guard.
    const { ctx } = makeCtx([
      { text: JSON.stringify({ ref_image_indices: [99, 100], text_prompt: 'x' }) },
    ])

    await expect(
      meta.compose({ input: { frameDescription: 'x', candidates } }, ctx),
    ).rejects.toThrow(/REFERENCE_SELECTION_INVALID.*all out of range/)
  })

  it('emits exactly the input tags each stage prompt declares, with "Image N:" numbering', async () => {
    const meta = createReferenceImageCascadeMeta()
    const candidates = Array.from({ length: 9 }, (_, i) => ({
      ref: `h${i}`,
      text: `t${i}`,
    }))
    const { ctx, calls } = makeCtx([
      { text: JSON.stringify({ ref_image_indices: [0, 2], text_prompt: '' }) },
      { text: JSON.stringify({ ref_image_indices: [0], text_prompt: 'ok' }) },
    ])

    await meta.compose({ input: { frameDescription: 'a sunset', candidates } }, ctx)

    const prefilterTags = declaredTags(REFERENCE_IMAGE_PREFILTER_PROMPT)
    const selectTags = declaredTags(REFERENCE_IMAGE_MULTIMODAL_SELECT_PROMPT)
    expect(prefilterTags.sort()).toEqual(['FRAME_DESC', 'SEQ_DESC'])
    expect(selectTags.sort()).toEqual(['FRAME_DESC', 'SEQ_IMAGES'])

    const prefilterPrompt = String(calls[0].input.prompt)
    for (const tag of prefilterTags) {
      expect(prefilterPrompt).toContain(`<${tag}>`)
      expect(prefilterPrompt).toContain(`</${tag}>`)
    }
    const selectPrompt = String(calls[1].input.prompt)
    for (const tag of selectTags) {
      expect(selectPrompt).toContain(`<${tag}>`)
      expect(selectPrompt).toContain(`</${tag}>`)
    }

    // Both prompts index candidates as "Image N:" from 0 — the numbering the
    // returned ref_image_indices are read against.
    expect(prefilterPrompt).toContain('Image 0: t0')
    expect(prefilterPrompt).toContain('Image 8: t8')
    // Stage 2 renumbers over the narrowed subset [t0, t2].
    expect(selectPrompt).toContain('Image 0: t0')
    expect(selectPrompt).toContain('Image 1: t2')
    expect(selectPrompt).not.toContain('Image 2:')
  })

  it('returns empty selection when stage 2 legitimately picks nothing', async () => {
    // Distinct from the "all out of range" case: model returns [] meaning
    // "no candidate matches" — that is a valid outcome, must not throw.
    const meta = createReferenceImageCascadeMeta()
    const candidates = [
      { ref: 'h0', text: 'a' },
      { ref: 'h1', text: 'b' },
    ]
    const { ctx } = makeCtx([
      { text: JSON.stringify({ ref_image_indices: [], text_prompt: 'none match' }) },
    ])

    const out = await meta.compose(
      { input: { frameDescription: 'x', candidates } },
      ctx,
    )
    expect(out.selectedRefs).toEqual([])
    expect(out.textPrompt).toBe('none match')
  })
})
