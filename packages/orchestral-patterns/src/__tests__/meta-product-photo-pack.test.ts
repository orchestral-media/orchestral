import { describe, it, expect } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import type { TextToImageOutput } from '../atomic/text-to-image'
import { createProductPhotoPackMeta, ProductPhotoPackOutputSchema } from '../meta/product-photo-pack'
import { expectProducedAssetsEnvelope } from './helpers/produced-assets'

// ── fake output helpers ───────────────────────────────────────────────────

// Per-call cost so the aggregation assertion is non-trivial: shot n costs
// (n + 1) * 0.1 USD. The planning text-generation step costs TEXT_GEN_COST.
const TEXT_GEN_COST = 0.02
const t2iCost = (n: number): number => (n + 1) * 0.1

function fakeTextToImage(n: number): TextToImageOutput {
  return { modality: 'image', assets: [{ assetId: `shot-${n}`, modality: 'image' }], cost: t2iCost(n), latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeTextToImageEmpty(): TextToImageOutput {
  return { modality: 'image', assets: [], cost: 0, latencyMs: 0, model: 'm', provider: 'p' }
}

// ── slot plan helpers ─────────────────────────────────────────────────────

function makeSlots(names: string[]): { name: string; prompt: string }[] {
  return names.map((name, i) => ({ name, prompt: `prompt-${i}` }))
}

// ── ctx factory ───────────────────────────────────────────────────────────

function makeCtx(opts: {
  slotNames: string[]
  confirmed: boolean
  t2iOverride?: (n: number) => TextToImageOutput
}) {
  const calls: Array<{ patternId: string; input: Record<string, unknown> }> = []
  let t2iCount = 0

  // .confirm raw bridge must return { confirmed: boolean }
  const rawBridge = async (_req: { kind: string; payload: unknown }) => ({
    confirmed: opts.confirmed,
  })

  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown> })
      if (ref.patternId === 'text-generation')
        return { text: JSON.stringify({ slots: makeSlots(opts.slotNames) }), cost: TEXT_GEN_COST } as unknown as T
      if (ref.patternId === 'text-to-image') {
        const n = t2iCount++
        return (opts.t2iOverride ? opts.t2iOverride(n) : fakeTextToImage(n)) as unknown as T
      }
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext

  return { ctx, calls }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('meta_product-photo-pack', () => {
  it('clamps to maxSlots when text-generation returns more slots than requested', async () => {
    // maxSlots=2, text-gen returns 4 slots → only 2 text-to-image calls
    const { ctx, calls } = makeCtx({ slotNames: ['hero', 'lifestyle', 'macro', 'infographic'], confirmed: true })
    const out = await createProductPhotoPackMeta().compose(
      { input: { brief: 'a sleek stainless steel water bottle', maxSlots: 2 } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(2)
    expect(out.assets).toHaveLength(2)
    // cost = planning + 2 shots (0.1 + 0.2); latencyMs measured, non-negative.
    expect(out.cost).toBeCloseTo(TEXT_GEN_COST + t2iCost(0) + t2iCost(1))
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('confirm=false → zero text-to-image calls, returns { assets: [] }', async () => {
    const { ctx, calls } = makeCtx({ slotNames: ['hero', 'lifestyle', 'macro'], confirmed: false })
    const out = await createProductPhotoPackMeta().compose(
      { input: { brief: 'ceramic coffee mug', maxSlots: 3 } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(out.assets).toEqual([])
    // Only the planning step ran before the user declined.
    expect(out.cost).toBeCloseTo(TEXT_GEN_COST)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('confirm=true → N text-to-image calls, returns N labelled shots in slot order', async () => {
    const { ctx, calls } = makeCtx({ slotNames: ['hero', 'lifestyle', 'macro'], confirmed: true })
    const out = await createProductPhotoPackMeta().compose(
      { input: { brief: 'ceramic coffee mug', maxSlots: 3 } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(3)
    expect(out.assets).toEqual([
      { assetId: 'shot-0', modality: 'image', label: 'shot-0' },
      { assetId: 'shot-1', modality: 'image', label: 'shot-1' },
      { assetId: 'shot-2', modality: 'image', label: 'shot-2' },
    ])
    expect(out.cost).toBeCloseTo(
      TEXT_GEN_COST + t2iCost(0) + t2iCost(1) + t2iCost(2),
    )
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('malformed JSON from text-generation rejects with /did not return valid JSON/', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (_req: { kind: string; payload: unknown }) => ({ confirmed: false })
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: { patternId: string; input: Record<string, unknown> }): Promise<T> => {
        calls.push({ patternId: ref.patternId })
        if (ref.patternId === 'text-generation')
          return { text: 'not json{' } as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createProductPhotoPackMeta().compose(
        { input: { brief: 'ceramic mug', maxSlots: 2 } },
        ctx,
      ),
    ).rejects.toThrow(/did not return valid JSON/)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
  })

  it('empty slots array from text-generation rejects (Zod .min(1))', async () => {
    const { ctx, calls } = makeCtx({ slotNames: [], confirmed: true })
    await expect(
      createProductPhotoPackMeta().compose(
        { input: { brief: 'leather wallet', maxSlots: 3 } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
  })

  it('cancel: askUser.confirm bridge throws → compose rejects AND zero text-to-image calls after gate', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (_req: { kind: string; payload: unknown }): Promise<never> => {
      throw new Error('user cancelled')
    }
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: { patternId: string; input: Record<string, unknown> }): Promise<T> => {
        calls.push({ patternId: ref.patternId })
        if (ref.patternId === 'text-generation')
          return { text: JSON.stringify({ slots: makeSlots(['hero', 'lifestyle']) }) } as unknown as T
        if (ref.patternId === 'text-to-image')
          return fakeTextToImage(0) as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createProductPhotoPackMeta().compose(
        { input: { brief: 'sunglasses', maxSlots: 2 } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
  })

  it('empty-assets guard: text-to-image returning { assets: [] } rejects with "produced no asset"', async () => {
    const { ctx } = makeCtx({
      slotNames: ['hero'],
      confirmed: true,
      t2iOverride: () => fakeTextToImageEmpty(),
    })
    await expect(
      createProductPhotoPackMeta().compose(
        { input: { brief: 'leather wallet', maxSlots: 1 } },
        ctx,
      ),
    ).rejects.toThrow('produced no asset')
  })

  it('returns the produced-assets envelope: every shot labelled, no raw-id field anywhere', async () => {
    const { ctx } = makeCtx({ slotNames: ['hero', 'lifestyle'], confirmed: true })
    const out = await createProductPhotoPackMeta().compose(
      { input: { brief: 'ceramic coffee mug', maxSlots: 2 } },
      ctx,
    )
    expectProducedAssetsEnvelope(ProductPhotoPackOutputSchema, out)
  })

  it('declares the dispatch set an agent guard holds to its allowlist', () => {
    // The model picks how many shots; it never picks which patterns render
    // them, so the declaration does not move with maxSlots.
    const meta = createProductPhotoPackMeta()
    expect(meta.plannedDispatches?.({ brief: 'ceramic coffee mug', maxSlots: 4 })).toEqual([
      'text-generation',
      'text-to-image',
    ])
    expect(meta.plannedDispatches?.({ brief: 'ceramic coffee mug', maxSlots: 1 })).toEqual([
      'text-generation',
      'text-to-image',
    ])
  })
})
