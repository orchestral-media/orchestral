import { describe, it, expect, vi } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import type { TextToImageOutput } from '../atomic/text-to-image'
import type { ImageToVideoOutput } from '../atomic/image-to-video'
import type { TextToAudioOutput } from '../atomic/text-to-audio'
import { createProductAdShortMeta, ProductAdShortOutputSchema, type ProductAdShortMetaDeps } from '../meta/product-ad-short'
import { byLabel, expectProducedAssetsEnvelope } from './helpers/produced-assets'

// ── fake deps ─────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<ProductAdShortMetaDeps>): ProductAdShortMetaDeps {
  return {
    addBackgroundAudio: vi.fn().mockResolvedValue({ assetId: 'muxed-1' }),
    recordSessionAsset: vi.fn(async (_s: string, assetId: string) => ({ handle: `h-${assetId}` })),
    ...overrides,
  }
}

// ── fake step helpers ─────────────────────────────────────────────────────

// Distinct non-zero costs so aggregation is observable per sub-step.
const GEN_COST = 0.02
const HERO_COST = 0.1
const ANIMATE_COST = 0.4
const MUSIC_COST = 0.3

function fakeTextGeneration(heroPrompts: string[]) {
  return { text: JSON.stringify({ prompts: heroPrompts }), cost: GEN_COST }
}

function fakeTextToImage(n: number): TextToImageOutput {
  return { modality: 'image', assets: [{ assetId: `hero-${n}`, modality: 'image' }], cost: HERO_COST, latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeImageToVideo(): ImageToVideoOutput {
  return { modality: 'video', assets: [{ assetId: 'adclip-1', modality: 'video' }], cost: ANIMATE_COST, latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeTextToAudio(): TextToAudioOutput {
  return { modality: 'audio', assets: [{ assetId: 'music-1', modality: 'audio' }], cost: MUSIC_COST, latencyMs: 0, model: 'm', provider: 'p' }
}

// ── ctx factories ─────────────────────────────────────────────────────────

/**
 * makeCtx — for tests that use the FALLBACK (no-session) path.
 * The raw bridge returns opts.askAnswer directly; tests must pass the
 * text-label string the fallback .choose expects.
 */
function makeCtx(opts: {
  heroPrompts: string[]
  askAnswer: unknown
  sessionId?: string
  imageToVideoOverride?: () => ImageToVideoOutput
}) {
  const calls: Array<{ patternId: string; input: Record<string, unknown>; assets?: unknown }> = []
  let t2iCount = 0
  const rawBridge = async (_req: { kind: string; payload: unknown }) => opts.askAnswer
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    sessionId: opts.sessionId,
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown>, assets: (ref as unknown as { assets?: unknown }).assets })
      if (ref.patternId === 'text-generation')
        return fakeTextGeneration(opts.heroPrompts) as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      if (ref.patternId === 'image-to-video')
        return (opts.imageToVideoOverride ? opts.imageToVideoOverride() : fakeImageToVideo()) as unknown as T
      if (ref.patternId === 'text-to-audio') return fakeTextToAudio() as unknown as T
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

/**
 * makeCtxPick — for tests that inspect the ask payload and pick by index.
 * Supports both the thumbnail path (kind:'choice', options with {value,tag})
 * and the fallback text-label path (kind:'choice', options with {value,label}).
 * The bridge picks options[chooseIndex].value in both cases.
 */
function makeCtxPick(opts: {
  heroPrompts: string[]
  onAsk: (req: { kind: string; payload: unknown }) => void
  chooseIndex: number
  sessionId?: string
  imageToVideoOverride?: () => ImageToVideoOutput
}) {
  const calls: Array<{ patternId: string; input: Record<string, unknown>; assets?: unknown }> = []
  let t2iCount = 0
  const rawBridge = async (req: { kind: string; payload: unknown }) => {
    opts.onAsk(req)
    const payload = req.payload as { options?: { value: string }[]; mode?: string }
    if (req.kind === 'choice' && payload.options) {
      const chosen = payload.options[opts.chooseIndex].value
      // .custom expects { mode:'single', chosen } envelope; .choose (facade) expects { chosen }
      // The facade for .choose wraps to { chosen } — but rawBridge receives the full payload.
      // Both custom and choose use kind:'choice'; custom needs mode in answer, choose doesn't.
      if (payload.mode === 'single') {
        return { mode: 'single', chosen }
      }
      return { chosen }
    }
    return {}
  }
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    sessionId: opts.sessionId,
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown>, assets: (ref as unknown as { assets?: unknown }).assets })
      if (ref.patternId === 'text-generation')
        return fakeTextGeneration(opts.heroPrompts) as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      if (ref.patternId === 'image-to-video')
        return (opts.imageToVideoOverride ? opts.imageToVideoOverride() : fakeImageToVideo()) as unknown as T
      if (ref.patternId === 'text-to-audio') return fakeTextToAudio() as unknown as T
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

/**
 * makeCtxAskThrows — for cancel-path tests on either picker path.
 * The raw bridge rejects the picker ask (user closed the picker, park
 * aborted) instead of answering; steps past the picker must never fire.
 */
function makeCtxAskThrows(opts: { heroPrompts: string[]; sessionId?: string }) {
  const calls: Array<{ patternId: string; input: Record<string, unknown> }> = []
  let t2iCount = 0
  const rawBridge = async (_req: { kind: string; payload: unknown }): Promise<never> => {
    throw new Error('user cancelled')
  }
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    sessionId: opts.sessionId,
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown> })
      if (ref.patternId === 'text-generation')
        return fakeTextGeneration(opts.heroPrompts) as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

describe('meta_product-ad-short', () => {
  it('writes N hero prompts then generates N draft heros', async () => {
    // fallback path (no sessionId): askAnswer must be the text-label string .choose returns
    const { ctx, calls } = makeCtx({
      heroPrompts: ['p1', 'p2', 'p3'],
      // fallback .choose returns the chosen option string directly
      askAnswer: { chosen: 'Hero 1: p1' },
    })
    await createProductAdShortMeta(makeDeps()).compose(
      { input: { brief: 'a sleek water bottle', variantCount: 3, withMusic: false } },
      ctx,
    )
    expect(calls.filter(c => c.patternId === 'text-generation')).toHaveLength(1)
    expect(calls.filter(c => c.patternId === 'text-to-image')).toHaveLength(3)
  })

  it('asks the user to pick one hero (choice) and returns the CHOSEN hero, not the first', async () => {
    let askedKind: string | undefined
    // thumbnail path (sessionId set)
    const { ctx } = makeCtxPick({
      heroPrompts: ['p1', 'p2', 'p3'],
      onAsk: (req) => { askedKind = req.kind },
      chooseIndex: 1,
      sessionId: 's1',
    })
    const out = await createProductAdShortMeta(makeDeps()).compose(
      { input: { brief: 'x', variantCount: 3, withMusic: false } }, ctx,
    )
    expect(askedKind).toBe('choice')
    // withMusic=false → no mux → the final video IS the raw ad clip
    expect(out.assets).toEqual([{ assetId: 'adclip-1', modality: 'video', label: 'final-video' }])
  })

  it('animates the chosen hero (threaded as startFrame) into the ad clip', async () => {
    const deps = makeDeps()
    // thumbnail path (sessionId set), pick index 1 → hero-1
    const { ctx, calls } = makeCtxPick({ heroPrompts: ['p1', 'p2'], chooseIndex: 1, onAsk: () => {}, sessionId: 's1' })
    const out = await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
    )
    const i2v = calls.find((c) => c.patternId === 'image-to-video')!
    expect(i2v.assets).toMatchObject([{ slot: 'startFrame', assetId: 'hero-1' }])
    // withMusic=false → no mux → the final video IS the raw clip, and no music element
    expect(byLabel(out, 'final-video')).toMatchObject({ assetId: 'adclip-1', modality: 'video' })
    expect(byLabel(out, 'music')).toBeUndefined()
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(0)
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()
    // cost = gen + ALL 2 hero drafts + animate (no music) = 0.02 + 2*0.1 + 0.4
    expect(out.cost).toBeCloseTo(GEN_COST + 2 * HERO_COST + ANIMATE_COST)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('with withMusic, muxes music into clip and labels the muxed clip final-video', async () => {
    const deps = makeDeps()
    // thumbnail path (sessionId set), pick index 0 → hero-0
    const { ctx, calls } = makeCtxPick({ heroPrompts: ['p1'], chooseIndex: 0, onAsk: () => {}, sessionId: 's1' })
    const out = await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 1, withMusic: true } }, ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(1)
    expect(byLabel(out, 'music')).toMatchObject({ assetId: 'music-1', modality: 'audio' })
    // addBackgroundAudio called with (adclip, music, {mode:'replace'}) — silent clip has no audio track
    expect(deps.addBackgroundAudio).toHaveBeenCalledWith('adclip-1', 'music-1', { mode: 'replace' })
    expect(byLabel(out, 'final-video')).toMatchObject({ assetId: 'muxed-1', modality: 'video' })
    expect(out.assets.map((a) => a.label)).toEqual(['final-video', 'music'])
    // cost = gen + 1 hero draft + animate + music (host mux adds none) = 0.02 + 0.1 + 0.4 + 0.3
    expect(out.cost).toBeCloseTo(GEN_COST + HERO_COST + ANIMATE_COST + MUSIC_COST)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  // ── Fix G edge-case tests ─────────────────────────────────────────────

  it('Fix G-1: clamps to variantCount when model returns more prompts than requested', async () => {
    // fallback path (no sessionId)
    const { ctx, calls } = makeCtx({
      heroPrompts: ['p1', 'p2', 'p3'],
      askAnswer: { chosen: 'Hero 1: p1' },
    })
    await createProductAdShortMeta(makeDeps()).compose(
      { input: { brief: 'water bottle', variantCount: 2, withMusic: false } },
      ctx,
    )
    expect(calls.filter(c => c.patternId === 'text-to-image')).toHaveLength(2)
  })

  it('Fix G-2: rejects with descriptive error when text-generation returns empty prompts array', async () => {
    const { ctx, calls } = makeCtx({
      heroPrompts: [],
      askAnswer: {},
    })
    await expect(
      createProductAdShortMeta(makeDeps()).compose(
        { input: { brief: 'water bottle', variantCount: 3, withMusic: false } },
        ctx,
      )
    ).rejects.toThrow()
    // No text-to-image calls should have fired
    expect(calls.filter(c => c.patternId === 'text-to-image')).toHaveLength(0)
  })

  it('malformed JSON from text-generation rejects with /did not return valid JSON/', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (_req: { kind: string; payload: unknown }) => ({})
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
      createProductAdShortMeta(makeDeps()).compose(
        { input: { brief: 'water bottle', variantCount: 2, withMusic: false } },
        ctx,
      ),
    ).rejects.toThrow(/did not return valid JSON/)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
  })

  it('Fix G-3: rejects with "produced no asset" error when image-to-video returns empty assets', async () => {
    const { ctx } = makeCtxPick({
      heroPrompts: ['p1'],
      chooseIndex: 0,
      onAsk: () => {},
      sessionId: 's1',
      imageToVideoOverride: () => ({
        modality: 'video' as const,
        assets: [],
        cost: 0,
        latencyMs: 0,
        model: 'm',
        provider: 'p',
      }),
    })
    await expect(
      createProductAdShortMeta(makeDeps()).compose(
        { input: { brief: 'x', variantCount: 1, withMusic: false } },
        ctx,
      )
    ).rejects.toThrow('product-ad-short: image-to-video produced no asset')
  })

  // ── G5 — thumbnail path tests ─────────────────────────────────────────

  it('G5 thumbnail path: registers each draft hero → recordSessionAsset called per hero', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtxPick({ heroPrompts: ['p1', 'p2', 'p3'], chooseIndex: 0, onAsk: () => {}, sessionId: 's1' })
    await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 3, withMusic: false } }, ctx,
    )
    expect(deps.recordSessionAsset).toHaveBeenCalledTimes(3)
    expect(deps.recordSessionAsset).toHaveBeenCalledWith('s1', 'hero-0', 'image')
    expect(deps.recordSessionAsset).toHaveBeenCalledWith('s1', 'hero-1', 'image')
    expect(deps.recordSessionAsset).toHaveBeenCalledWith('s1', 'hero-2', 'image')
  })

  it('G5 thumbnail path: choice payload options carry tag:image and handle values', async () => {
    const deps = makeDeps()
    let capturedPayload: unknown
    const { ctx } = makeCtxPick({
      heroPrompts: ['p1', 'p2'],
      onAsk: (req) => { capturedPayload = req.payload },
      chooseIndex: 0,
      sessionId: 's1',
    })
    await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
    )
    const payload = capturedPayload as { options: { value: string; tag: string }[] }
    expect(payload.options).toHaveLength(2)
    expect(payload.options[0]).toMatchObject({ value: 'h-hero-0', tag: 'image' })
    expect(payload.options[1]).toMatchObject({ value: 'h-hero-1', tag: 'image' })
  })

  it('G5 thumbnail path: picking the 2nd handle maps back to hero-1 as startFrame', async () => {
    const deps = makeDeps()
    // chooseIndex:1 → picks handle h-hero-1 → maps back to heroAssetIds[1] = hero-1
    const { ctx, calls } = makeCtxPick({ heroPrompts: ['p1', 'p2'], chooseIndex: 1, onAsk: () => {}, sessionId: 's1' })
    await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
    )
    const i2v = calls.find((c) => c.patternId === 'image-to-video')!
    expect(i2v.assets).toMatchObject([{ slot: 'startFrame', assetId: 'hero-1' }])
  })

  it('G5 fallback path: no sessionId → uses text-label choose, no recordSessionAsset calls', async () => {
    const deps = makeDeps()
    // No sessionId → fallback path. makeCtxPick with no sessionId.
    const { ctx, calls } = makeCtxPick({ heroPrompts: ['p1', 'p2'], chooseIndex: 1, onAsk: () => {}, sessionId: undefined })
    await createProductAdShortMeta(deps).compose(
      { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
    )
    expect(deps.recordSessionAsset).not.toHaveBeenCalled()
    const i2v = calls.find((c) => c.patternId === 'image-to-video')!
    // fallback pick index 1 → hero-1 (text label "Hero 2: p2")
    expect(i2v.assets).toMatchObject([{ slot: 'startFrame', assetId: 'hero-1' }])
  })

  // ── picker edge cases: cancel + invalid pick, both paths ──────────────

  it('cancel thumbnail path: picker bridge throws → compose rejects AND zero image-to-video / text-to-audio calls', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtxAskThrows({ heroPrompts: ['p1', 'p2'], sessionId: 's1' })
    await expect(
      createProductAdShortMeta(deps).compose(
        { input: { brief: 'x', variantCount: 2, withMusic: true } }, ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(0)
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()
  })

  it('cancel fallback path: picker bridge throws → compose rejects AND zero image-to-video / text-to-audio calls', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtxAskThrows({ heroPrompts: ['p1', 'p2'], sessionId: undefined })
    await expect(
      createProductAdShortMeta(deps).compose(
        { input: { brief: 'x', variantCount: 2, withMusic: true } }, ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(0)
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()
  })

  it('invalid pick thumbnail path: chosen value not among minted handles → rejects with "chosen hero handle not found"', async () => {
    const { ctx, calls } = makeCtx({
      heroPrompts: ['p1', 'p2'],
      // valid handles are h-hero-0 / h-hero-1; this passes the answerSchema but maps to no hero
      askAnswer: { mode: 'single', chosen: 'not-a-real-handle' },
      sessionId: 's1',
    })
    await expect(
      createProductAdShortMeta(makeDeps()).compose(
        { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
      ),
    ).rejects.toThrow(/chosen hero handle not found/)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('invalid pick fallback path: chosen value not among offered options → rejects', async () => {
    const { ctx, calls } = makeCtx({
      heroPrompts: ['p1', 'p2'],
      askAnswer: { chosen: 'not-a-real-option' },
    })
    // Don't pin which layer throws: today it's the meta's own chosenIdx < 0
    // guard; if the facade's choose() gains membership validation it rejects
    // one layer earlier with a different message.
    await expect(
      createProductAdShortMeta(makeDeps()).compose(
        { input: { brief: 'x', variantCount: 2, withMusic: false } }, ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('returns the produced-assets envelope: every element labelled, no raw-id field anywhere', async () => {
    const { ctx } = makeCtxPick({ heroPrompts: ['p1'], chooseIndex: 0, onAsk: () => {}, sessionId: 's1' })
    const out = await createProductAdShortMeta(makeDeps()).compose(
      { input: { brief: 'x', variantCount: 1, withMusic: true } }, ctx,
    )
    expectProducedAssetsEnvelope(ProductAdShortOutputSchema, out)
  })
})
