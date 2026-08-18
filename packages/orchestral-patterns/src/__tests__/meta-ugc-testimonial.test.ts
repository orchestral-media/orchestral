import { describe, it, expect, vi } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import type { TextToImageOutput } from '../atomic/text-to-image'
import type { ImageToVideoOutput } from '../atomic/image-to-video'
import type { TextToSpeechOutput } from '../atomic/text-to-speech'
import { createUgcTestimonialMeta, toSrt, type UgcTestimonialMetaDeps } from '../meta/ugc-testimonial'

describe('toSrt (SubRip formatting)', () => {
  it('floors milliseconds so a fractional second never overflows to a 4-digit field', () => {
    const srt = toSrt([
      { startSecond: 0, endSecond: 1.9999, text: 'a' },
      { startSecond: 59.9999, endSecond: 61.5, text: 'b' },
    ])
    // floored ms is always ≤ 999 → never a malformed `,1000` cue
    expect(srt).not.toMatch(/,\d{4}/)
    expect(srt).toContain('00:00:00,000 --> 00:00:01,999')
    expect(srt).toContain('00:00:59,999 --> 00:01:01,500')
    // 1-based index, blank-line-separated cues
    expect(srt.startsWith('1\n')).toBe(true)
    expect(srt).toContain('\n\n2\n')
  })
})

// ── fake deps ─────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<UgcTestimonialMetaDeps>): UgcTestimonialMetaDeps {
  return {
    concatVideos: vi.fn().mockResolvedValue({ assetId: 'stitched-1' }),
    addBackgroundAudio: vi.fn().mockResolvedValue({ assetId: 'muxed-1' }),
    addSubtitles: vi.fn().mockResolvedValue({ assetId: 'subbed-1' }),
    createSubtitleAsset: vi.fn().mockResolvedValue({ assetId: 'srt-1' }),
    ...overrides,
  }
}

// ── fake output helpers ───────────────────────────────────────────────────

// Distinct non-zero per-call costs so the meta's aggregated `cost` is provably
// the sum of exactly the sub-steps that ran (gen + vo + hero + shots + asr).
const GEN_COST = 0.02
const TTS_COST = 0.2
const HERO_COST = 0.1
const SHOT_COST = 0.4
const ASR_COST = 0.05

function fakeTextToSpeech(): TextToSpeechOutput {
  return {
    modality: 'audio',
    assets: [{ assetId: 'vo-1', modality: 'audio' }],
    cost: TTS_COST,
    latencyMs: 0,
    model: 'm',
    provider: 'p',
  }
}

function fakeTextToImage(n: number): TextToImageOutput {
  return {
    modality: 'image',
    assets: [{ assetId: `hero-${n}`, modality: 'image' }],
    cost: HERO_COST,
    latencyMs: 0,
    model: 'm',
    provider: 'p',
  }
}

function fakeImageToVideo(n: number): ImageToVideoOutput {
  return {
    modality: 'video',
    assets: [{ assetId: `clip-${n}`, modality: 'video' }],
    cost: SHOT_COST,
    latencyMs: 0,
    model: 'm',
    provider: 'p',
  }
}

// ── ctx factory ───────────────────────────────────────────────────────────

type CallRecord = { patternId: string; input: Record<string, unknown>; assets?: unknown }

function makeCtx(opts: {
  scriptJson: { script: string; shots: { motion: string }[] }
  confirmAnswer: boolean
  imageToVideoOverride?: (callN: number) => ImageToVideoOutput
  // ASR segments returned for the automatic-speech-recognition step. The real
  // host emits seconds-based startSecond/endSecond, so model that shape here.
  asrSegments?: { startSecond: number; endSecond: number; text: string }[]
  asrCost?: number
}) {
  const calls: CallRecord[] = []
  let t2iCount = 0
  let i2vCount = 0

  // The raw bridge for .confirm must return { confirmed: boolean };
  // the facade unwraps it to a bare boolean.
  const rawBridge = async (req: { kind: string; payload: unknown }) => {
    if (req.kind === 'confirm') return { confirmed: opts.confirmAnswer }
    return {}
  }

  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    step: async <T>(ref: PatternRef): Promise<T> => {
      calls.push({
        patternId: ref.patternId,
        input: ref.input as Record<string, unknown>,
        assets: (ref as unknown as { assets?: unknown }).assets,
      })
      if (ref.patternId === 'text-generation')
        return { text: JSON.stringify(opts.scriptJson), cost: GEN_COST } as unknown as T
      if (ref.patternId === 'text-to-speech')
        return fakeTextToSpeech() as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      if (ref.patternId === 'image-to-video') {
        const n = i2vCount++
        return (opts.imageToVideoOverride ? opts.imageToVideoOverride(n) : fakeImageToVideo(n)) as unknown as T
      }
      if (ref.patternId === 'automatic-speech-recognition') {
        return {
          modality: 'text',
          text: (opts.asrSegments ?? []).map((s) => s.text).join(' '),
          ...(opts.asrSegments ? { segments: opts.asrSegments } : {}),
          cost: opts.asrCost ?? ASR_COST,
          latencyMs: 0,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext

  return { ctx, calls }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('meta_ugc-testimonial', () => {
  it('word-count→shot sizing: targetSeconds:20 with no shots → cap=4; 6 model shots → exactly 4 image-to-video calls', async () => {
    // targetSeconds=20 → shotCap = ceil(20/5) = 4
    // model returns 6 shots but only 4 should be animated
    const sixShots = Array.from({ length: 6 }, (_, i) => ({ motion: `motion-${i}` }))
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Great product I love it.', shots: sixShots },
      confirmAnswer: true,
    })

    const out = await createUgcTestimonialMeta(makeDeps()).compose(
      { input: { product: 'Acme Blender', targetSeconds: 20, subtitles: false } },
      ctx,
    )

    const i2vCalls = calls.filter(c => c.patternId === 'image-to-video')
    expect(i2vCalls).toHaveLength(4)
    expect(out.shotClipAssetIds).toHaveLength(4)
  })

  it('hero startFrame identity: every image-to-video call uses same heroAssetId as startFrame', async () => {
    const { ctx, calls } = makeCtx({
      scriptJson: {
        script: 'I love this blender.',
        shots: [{ motion: 'slow push-in' }, { motion: 'slight reframe' }, { motion: 'handheld zoom' }],
      },
      confirmAnswer: true,
    })

    await createUgcTestimonialMeta(makeDeps()).compose(
      { input: { product: 'Acme Blender', targetSeconds: 20, shots: 3, subtitles: false } },
      ctx,
    )

    // hero-0 is the t2i result (t2iCount starts at 0)
    const heroAssetId = 'hero-0'
    const i2vCalls = calls.filter(c => c.patternId === 'image-to-video')
    expect(i2vCalls).toHaveLength(3)
    for (const call of i2vCalls) {
      expect(call.assets).toMatchObject([{ slot: 'startFrame', assetId: heroAssetId, modality: 'image' }])
    }
  })

  it('TTS happens and voAssetId returned; hero t2i happens and heroAssetId returned', async () => {
    const { ctx, calls, } = makeCtx({
      scriptJson: { script: 'Best product ever!', shots: [{ motion: 'push-in' }] },
      confirmAnswer: true,
    })

    const out = await createUgcTestimonialMeta(makeDeps()).compose(
      { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: false } },
      ctx,
    )

    expect(calls.filter(c => c.patternId === 'text-to-speech')).toHaveLength(1)
    expect(out.voAssetId).toBe('vo-1')

    expect(calls.filter(c => c.patternId === 'text-to-image')).toHaveLength(1)
    expect(out.heroAssetId).toBe('hero-0')
  })

  it('confirm=false → zero image-to-video calls, shotClipAssetIds: [], but heroAssetId + voAssetId present; no videoAssetId', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtx({
      scriptJson: {
        script: 'Amazing stuff.',
        shots: [{ motion: 'push-in' }, { motion: 'reframe' }],
      },
      confirmAnswer: false,
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 15, shots: 2, subtitles: false } },
      ctx,
    )

    expect(calls.filter(c => c.patternId === 'image-to-video')).toHaveLength(0)
    expect(out.shotClipAssetIds).toEqual([])
    expect(out.heroAssetId).toBe('hero-0')
    expect(out.voAssetId).toBe('vo-1')
    expect(out.videoAssetId).toBeUndefined()
    expect(deps.concatVideos).not.toHaveBeenCalled()
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()

    // Decline path animates no shots and runs no ASR, so cost is exactly
    // gen + vo + hero. 0.02 + 0.2 + 0.1 = 0.32.
    expect(out.cost).toBeCloseTo(GEN_COST + TTS_COST + HERO_COST)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('confirm=true → concat(shotClips) then addBackgroundAudio(stitched, vo, {mode:replace}); videoAssetId set', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx({
      scriptJson: {
        script: 'Love this product.',
        shots: [{ motion: 'slow push-in' }, { motion: 'slight reframe' }],
      },
      confirmAnswer: true,
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 15, shots: 2, subtitles: false } },
      ctx,
    )

    expect(deps.concatVideos).toHaveBeenCalledWith(out.shotClipAssetIds)
    expect(deps.addBackgroundAudio).toHaveBeenCalledWith('stitched-1', 'vo-1', { mode: 'replace' })
    expect(out.videoAssetId).toBe('muxed-1')
  })

  it('empty-assets guard on image-to-video → throws "produced no asset"', async () => {
    const { ctx } = makeCtx({
      scriptJson: { script: 'Love it.', shots: [{ motion: 'slow push-in' }] },
      confirmAnswer: true,
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
      createUgcTestimonialMeta(makeDeps()).compose(
        { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: false } },
        ctx,
      ),
    ).rejects.toThrow('ugc-testimonial: image-to-video produced no asset')
  })

  it('malformed JSON from text-generation rejects with /did not return valid JSON/', async () => {
    const calls: CallRecord[] = []
    const rawBridge = async (_req: { kind: string; payload: unknown }) => ({ confirmed: false })
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: PatternRef): Promise<T> => {
        calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown> })
        if (ref.patternId === 'text-generation')
          return { text: 'not json{' } as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createUgcTestimonialMeta(makeDeps()).compose(
        { input: { product: 'Widget Pro', targetSeconds: 15, subtitles: false } },
        ctx,
      ),
    ).rejects.toThrow(/did not return valid JSON/)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('empty shots array from text-generation rejects (Zod .min(1))', async () => {
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Great product!', shots: [] },
      confirmAnswer: true,
    })
    await expect(
      createUgcTestimonialMeta(makeDeps()).compose(
        { input: { product: 'Widget Pro', targetSeconds: 10, subtitles: false } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('under-count: model returns fewer shots than shotCap → exactly model-shot-count image-to-video calls', async () => {
    // targetSeconds:20 → shotCap = ceil(20/5) = 4; model returns only 2 shots → 2 i2v calls
    const twoShots = [{ motion: 'slow push-in' }, { motion: 'slight reframe' }]
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Great product.', shots: twoShots },
      confirmAnswer: true,
    })
    await createUgcTestimonialMeta(makeDeps()).compose(
      { input: { product: 'Acme Blender', targetSeconds: 20, subtitles: false } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(2)
  })

  it('explicit shots param overrides auto-sizing', async () => {
    const threeShots = Array.from({ length: 3 }, (_, i) => ({ motion: `motion-${i}` }))
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Great!', shots: threeShots },
      confirmAnswer: true,
    })

    await createUgcTestimonialMeta(makeDeps()).compose(
      // targetSeconds=60 would auto-cap to 6, but shots=2 overrides
      { input: { product: 'Widget Pro', targetSeconds: 60, shots: 2, subtitles: false } },
      ctx,
    )

    expect(calls.filter(c => c.patternId === 'image-to-video')).toHaveLength(2)
  })

  it('subtitles on + ASR has segments → createSubtitleAsset(srt) + addSubtitles(video,srt-1,{hard}); videoAssetId=subbed-1', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Love this product.', shots: [{ motion: 'push-in' }] },
      confirmAnswer: true,
      asrSegments: [
        { startSecond: 0, endSecond: 1.5, text: 'Love this' },
        { startSecond: 1.5, endSecond: 3, text: 'product.' },
      ],
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: true } },
      ctx,
    )

    // ASR step dispatched against the VO via the 'source' audio slot.
    const asrCalls = calls.filter((c) => c.patternId === 'automatic-speech-recognition')
    expect(asrCalls).toHaveLength(1)
    expect(asrCalls[0].input).toMatchObject({ timestamps: 'segment' })
    expect(asrCalls[0].assets).toMatchObject([{ slot: 'source', assetId: 'vo-1', modality: 'audio' }])

    // createSubtitleAsset called with a real SRT string built from the segments.
    expect(deps.createSubtitleAsset).toHaveBeenCalledTimes(1)
    const srt = (deps.createSubtitleAsset as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(srt).toContain('00:00:00,000 --> 00:00:01,500')
    expect(srt).toContain('Love this')
    expect(srt).toContain('00:00:01,500 --> 00:00:03,000')
    expect(srt).toContain('product.')

    // burned onto the muxed video, replacing videoAssetId with the subbed asset.
    expect(deps.addSubtitles).toHaveBeenCalledWith('muxed-1', 'srt-1', { mode: 'hard' })
    expect(out.videoAssetId).toBe('subbed-1')

    // Aggregated cost = gen + vo + hero + one animated shot + asr; host mux/sub
    // ops add nothing. 0.02 + 0.2 + 0.1 + 0.4 + 0.05 = 0.77.
    expect(out.cost).toBeCloseTo(GEN_COST + TTS_COST + HERO_COST + SHOT_COST + ASR_COST)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps cost finite when ASR reports NaN (sumCosts guard)', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx({
      scriptJson: { script: 'Love this product.', shots: [{ motion: 'push-in' }] },
      confirmAnswer: true,
      asrSegments: [{ startSecond: 0, endSecond: 1.5, text: 'Love this' }],
      asrCost: Number.NaN,
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: true } },
      ctx,
    )

    // The NaN ASR cost is guarded to 0 — gen + vo + hero + shot still sum
    // finitely instead of the whole run reporting NaN.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBeCloseTo(GEN_COST + TTS_COST + HERO_COST + SHOT_COST)
  })

  it('subtitles on but ASR returns no segments → neither sub dep called; videoAssetId = pre-sub muxed id', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Love this product.', shots: [{ motion: 'push-in' }] },
      confirmAnswer: true,
      // no asrSegments → ASR result carries no segments
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: true } },
      ctx,
    )

    expect(calls.filter((c) => c.patternId === 'automatic-speech-recognition')).toHaveLength(1)
    expect(deps.createSubtitleAsset).not.toHaveBeenCalled()
    expect(deps.addSubtitles).not.toHaveBeenCalled()
    expect(out.videoAssetId).toBe('muxed-1')
  })

  it('subtitles:false → no ASR call; videoAssetId = muxed id', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtx({
      scriptJson: { script: 'Love this product.', shots: [{ motion: 'push-in' }] },
      confirmAnswer: true,
      asrSegments: [{ startSecond: 0, endSecond: 1, text: 'unused' }],
    })

    const out = await createUgcTestimonialMeta(deps).compose(
      { input: { product: 'Widget Pro', targetSeconds: 10, shots: 1, subtitles: false } },
      ctx,
    )

    expect(calls.filter((c) => c.patternId === 'automatic-speech-recognition')).toHaveLength(0)
    expect(deps.createSubtitleAsset).not.toHaveBeenCalled()
    expect(deps.addSubtitles).not.toHaveBeenCalled()
    expect(out.videoAssetId).toBe('muxed-1')
  })
})
