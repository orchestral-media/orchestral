import { describe, it, expect, vi } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import type { TextToImageOutput } from '../atomic/text-to-image'
import type { ImageToVideoOutput } from '../atomic/image-to-video'
import type { TextToAudioOutput } from '../atomic/text-to-audio'
import { createLyricsToMvMeta, LyricsToMvOutputSchema, type LyricsToMvMetaDeps } from '../meta/lyrics-to-mv'
import { byLabel, expectProducedAssetsEnvelope } from './helpers/produced-assets'

// ── fake deps ─────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<LyricsToMvMetaDeps>): LyricsToMvMetaDeps {
  return {
    concatVideos: vi.fn().mockResolvedValue({ assetId: 'stitched-1' }),
    addBackgroundAudio: vi.fn().mockResolvedValue({ assetId: 'muxed-1' }),
    ...overrides,
  }
}

// ── fake output helpers ───────────────────────────────────────────────────

function fakeTextToImage(n: number): TextToImageOutput {
  return { modality: 'image', assets: [{ assetId: `still-${n}`, modality: 'image' }], cost: 0.1, latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeImageToVideo(n: number): ImageToVideoOutput {
  return { modality: 'video', assets: [{ assetId: `clip-${n}`, modality: 'video' }], cost: 0.4, latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeTextToAudio(): TextToAudioOutput {
  return { modality: 'audio', assets: [{ assetId: 'music-1', modality: 'audio' }], cost: 0.3, latencyMs: 0, model: 'm', provider: 'p' }
}

// ── ctx factory ───────────────────────────────────────────────────────────

type CallRecord = { patternId: string; input: Record<string, unknown>; assets?: unknown }

function makeCtx(opts: {
  keyframePrompts: { prompt: string }[]
  confirmAnswer: boolean
  imageToVideoOverride?: (callN: number) => ImageToVideoOutput
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
        return { text: JSON.stringify({ keyframes: opts.keyframePrompts }), cost: 0.02 } as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      if (ref.patternId === 'image-to-video') {
        const n = i2vCount++
        return (opts.imageToVideoOverride ? opts.imageToVideoOverride(n) : fakeImageToVideo(n)) as unknown as T
      }
      if (ref.patternId === 'text-to-audio') return fakeTextToAudio() as unknown as T
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext

  return { ctx, calls }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('meta_lyrics-to-mv', () => {
  it('keyframe clamp: text-gen returns more keyframes than input.keyframes → exactly input.keyframes t2i + i2v calls', async () => {
    // input.keyframes=2 but text-generation returns 4 → only 2 t2i + 2 i2v calls
    const fourFrames = [
      { prompt: 'frame 1' },
      { prompt: 'frame 2' },
      { prompt: 'frame 3' },
      { prompt: 'frame 4' },
    ]
    const { ctx, calls } = makeCtx({
      keyframePrompts: fourFrames,
      confirmAnswer: true,
    })
    await createLyricsToMvMeta(makeDeps()).compose(
      { input: { theme: 'lonely highway', keyframes: 2, musicDurationSeconds: 30 } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(2)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(2)
  })

  it('style lands as a <STYLE> block in the planning prompt but stays plain prose in the audio prompt', async () => {
    const { ctx, calls } = makeCtx({
      keyframePrompts: [{ prompt: 'frame 1' }],
      confirmAnswer: true,
    })
    await createLyricsToMvMeta(makeDeps()).compose(
      {
        input: {
          theme: 'lonely highway',
          style: 'neon noir',
          keyframes: 1,
          musicDurationSeconds: 30,
        },
      },
      ctx,
    )
    const planning = calls.find((c) => c.patternId === 'text-generation')
    expect(planning?.input.prompt).toContain('<STYLE>\nneon noir\n</STYLE>')
    // The audio prompt is a descriptive phrase for a music model, NOT a
    // structured directive — deliberately excluded from the styleTag
    // convergence (see plans/README.md round-5 rejections).
    const audio = calls.find((c) => c.patternId === 'text-to-audio')
    expect(audio?.input.prompt).toBe('Music for: lonely highway, neon noir')
  })

  it('confirm=false → ZERO text-to-audio / text-to-image / image-to-video calls; returns { assets: [] }', async () => {
    const deps = makeDeps()
    const { ctx, calls } = makeCtx({
      keyframePrompts: [{ prompt: 'frame 1' }, { prompt: 'frame 2' }, { prompt: 'frame 3' }],
      confirmAnswer: false,
    })
    const out = await createLyricsToMvMeta(deps).compose(
      { input: { theme: 'neon city rain', keyframes: 3, musicDurationSeconds: 30 } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
    expect(out.assets).toEqual([])
    expect(deps.concatVideos).not.toHaveBeenCalled()
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()
    // Decline path only bills the planning text-generation (0.02); nothing paid ran.
    expect(out.cost).toBeCloseTo(0.02)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('confirm=true → exactly ONE text-to-audio call; music asset labelled; N clips in keyframe order; each image-to-video gets its keyframe still as startFrame', async () => {
    const threeFrames = [
      { prompt: 'golden field at dawn, warm haze, wide angle' },
      { prompt: 'golden field at noon, stark shadows, wide angle' },
      { prompt: 'golden field at dusk, orange sky, wide angle' },
    ]
    const { ctx, calls } = makeCtx({
      keyframePrompts: threeFrames,
      confirmAnswer: true,
    })
    const out = await createLyricsToMvMeta(makeDeps()).compose(
      { input: { theme: 'golden fields', keyframes: 3, musicDurationSeconds: 30 } },
      ctx,
    )

    // Exactly one music generation
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(1)
    expect(byLabel(out, 'music')).toMatchObject({ assetId: 'music-1', modality: 'audio' })

    // Exactly 3 clips, labelled in keyframe order
    expect(out.assets.filter((a) => a.label.startsWith('clip-')).map((a) => a.label)).toEqual([
      'clip-0',
      'clip-1',
      'clip-2',
    ])

    // Each image-to-video receives the still from the paired text-to-image as startFrame
    const i2vCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(i2vCalls).toHaveLength(3)

    // still-0 → clip-0, still-1 → clip-1, still-2 → clip-2
    // Due to parallel execution order may vary; verify each i2v has a startFrame asset
    for (const call of i2vCalls) {
      const assets = call.assets as { slot: string; assetId: string; modality: string }[]
      expect(assets).toMatchObject([{ slot: 'startFrame', modality: 'image' }])
      // assetId must be one of the generated stills
      expect(assets[0].assetId).toMatch(/^still-\d+$/)
    }

    // Aggregated cost = gen (0.02) + music (0.3) + 3×still (0.1) + 3×clip (0.4).
    // Host concat/mux steps add nothing.
    expect(out.cost).toBeCloseTo(0.02 + 0.3 + 3 * 0.1 + 3 * 0.4)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('confirm=true → concat(clips) then addBackgroundAudio(stitched, music, {mode:replace}); final-video labelled', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx({
      keyframePrompts: [{ prompt: 'frame 1' }, { prompt: 'frame 2' }],
      confirmAnswer: true,
    })
    const out = await createLyricsToMvMeta(deps).compose(
      { input: { theme: 'golden fields', keyframes: 2, musicDurationSeconds: 20 } },
      ctx,
    )

    const clipIds = out.assets.filter((a) => a.label.startsWith('clip-')).map((a) => a.assetId)
    expect(clipIds).toHaveLength(2)
    expect(deps.concatVideos).toHaveBeenCalledWith(clipIds)
    expect(deps.addBackgroundAudio).toHaveBeenCalledWith('stitched-1', 'music-1', { mode: 'replace' })
    expect(byLabel(out, 'final-video')).toMatchObject({ assetId: 'muxed-1', modality: 'video' })
    // Role order: music bed, clips in keyframe order, then the stitched MV.
    expect(out.assets.map((a) => a.label)).toEqual(['music', 'clip-0', 'clip-1', 'final-video'])
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
      createLyricsToMvMeta(makeDeps()).compose(
        { input: { theme: 'desert at midnight', keyframes: 2, musicDurationSeconds: 10 } },
        ctx,
      ),
    ).rejects.toThrow(/did not return valid JSON/)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('cancel: askUser.confirm bridge throws → compose rejects AND zero text-to-audio / text-to-image / image-to-video calls after gate', async () => {
    const deps = makeDeps()
    const calls: CallRecord[] = []
    const rawBridge = async (_req: { kind: string; payload: unknown }): Promise<never> => {
      throw new Error('user cancelled')
    }
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: PatternRef): Promise<T> => {
        calls.push({ patternId: ref.patternId, input: ref.input as Record<string, unknown> })
        if (ref.patternId === 'text-generation')
          return { text: JSON.stringify({ keyframes: [{ prompt: 'frame 1' }, { prompt: 'frame 2' }] }) } as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createLyricsToMvMeta(deps).compose(
        { input: { theme: 'neon city rain', keyframes: 2, musicDurationSeconds: 30 } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-audio')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
    expect(deps.concatVideos).not.toHaveBeenCalled()
    expect(deps.addBackgroundAudio).not.toHaveBeenCalled()
  })

  it('empty keyframes array from text-generation rejects (Zod .min(1))', async () => {
    const { ctx, calls } = makeCtx({
      keyframePrompts: [],
      confirmAnswer: true,
    })
    await expect(
      createLyricsToMvMeta(makeDeps()).compose(
        { input: { theme: 'empty night', keyframes: 3, musicDurationSeconds: 20 } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'image-to-video')).toHaveLength(0)
  })

  it('empty-assets guard on a step → throws "produced no asset"', async () => {
    const { ctx } = makeCtx({
      keyframePrompts: [{ prompt: 'frame 1' }],
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
      createLyricsToMvMeta(makeDeps()).compose(
        { input: { theme: 'desert at midnight', keyframes: 2, musicDurationSeconds: 10 } },
        ctx,
      ),
    ).rejects.toThrow('produced no asset')
  })

  it('returns the produced-assets envelope: every element labelled, no raw-id field anywhere', async () => {
    const { ctx } = makeCtx({
      keyframePrompts: [{ prompt: 'frame 1' }, { prompt: 'frame 2' }],
      confirmAnswer: true,
    })
    const out = await createLyricsToMvMeta(makeDeps()).compose(
      { input: { theme: 'golden fields', keyframes: 2, musicDurationSeconds: 20 } },
      ctx,
    )
    expectProducedAssetsEnvelope(LyricsToMvOutputSchema, out)
  })
})
