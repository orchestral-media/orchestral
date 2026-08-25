import { describe, it, expect } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import type { TextGenerationOutput } from '../atomic/text-generation'
import type { TextToImageOutput } from '../atomic/text-to-image'
import type { TextToSpeechOutput } from '../atomic/text-to-speech'
import { createExplainerShortMeta, ExplainerShortOutputSchema } from '../meta/explainer-short'
import { byLabel, expectProducedAssetsEnvelope } from './helpers/produced-assets'

// ── fake output helpers ───────────────────────────────────────────────────

function fakeScenesJson(n: number): string {
  const types = ['hook', 'concept', 'broll', 'cta'] as const
  const scenes = Array.from({ length: n }, (_, i) => ({
    type: types[i % types.length],
    narration: `narration ${i}`,
    visual: `visual ${i}`,
  }))
  return JSON.stringify({ scenes })
}

function fakeTextGen(text: string): TextGenerationOutput {
  return { modality: 'text' as const, text, cost: 0.02, latencyMs: 0, model: 'm', provider: 'p' }
}

function fakeTextToImage(n: number): TextToImageOutput {
  return {
    modality: 'image',
    assets: [{ assetId: `img-${n}`, modality: 'image' }],
    cost: 0.1,
    latencyMs: 0,
    model: 'm',
    provider: 'p',
  }
}

function fakeTextToSpeech(n: number): TextToSpeechOutput {
  return {
    modality: 'audio',
    assets: [{ assetId: `vo-${n}`, modality: 'audio' }],
    cost: 0.05,
    latencyMs: 0,
    model: 'm',
    provider: 'p',
    audioDurationMs: 1000,
  }
}

/** Deps that throw if assembly is ever reached — for tests that reject earlier. */
function noopDeps() {
  return {
    stillToVideo: async () => {
      throw new Error('stillToVideo should not be called')
    },
    concatVideos: async () => {
      throw new Error('concatVideos should not be called')
    },
  }
}

// ── ctx factory ───────────────────────────────────────────────────────────

function makeCtx(opts: {
  /** Raw JSON returned by text-generation (scenes array). */
  scenesJson: string
  /** Raw bridge answer for askUser.form — { values: Record<string, string> }.
   *  Defaults to echoing back the payload fields unchanged. */
  formAnswer?: { values: Record<string, string> }
  /** Answer for the cost-gate askUser.confirm (default: confirmed). */
  confirmAnswer?: boolean
  /** Override for text-to-speech to return empty assets. */
  ttsOverride?: () => TextToSpeechOutput
}) {
  const calls: Array<{ patternId: string; input: Record<string, unknown> }> = []
  const askUserCalls: Array<{ kind: string; payload: unknown }> = []
  let t2iCount = 0
  let ttsCount = 0
  let segCount = 0

  const rawBridge = async (o: { kind: string; payload: unknown }) => {
    askUserCalls.push({ kind: o.kind, payload: o.payload })
    if (o.kind === 'confirm') return { confirmed: opts.confirmAnswer ?? true }
    const payload = o.payload as { fields: { key: string; value: string }[] }
    return (
      opts.formAnswer ?? {
        values: Object.fromEntries(payload.fields.map((f) => [f.key, f.value])),
      }
    )
  }

  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    step: async <T>(ref: PatternRef): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      calls.push({ patternId: ref.patternId, input })
      if (ref.patternId === 'text-generation')
        return fakeTextGen(opts.scenesJson) as unknown as T
      if (ref.patternId === 'text-to-image')
        return fakeTextToImage(t2iCount++) as unknown as T
      if (ref.patternId === 'text-to-speech') {
        const out = opts.ttsOverride ? opts.ttsOverride() : fakeTextToSpeech(ttsCount++)
        return out as unknown as T
      }
      throw new Error(`unexpected patternId ${ref.patternId}`)
    },
  } as unknown as ExecutionContext

  // Fake host deps for assembly. stillToVideo returns a per-call segment id;
  // concatVideos records the segment ids it was handed and returns a fixed id.
  const stillToVideoCalls: Array<{ imageAssetId: string; audioAssetId: string }> = []
  const concatVideosCalls: Array<readonly string[]> = []
  const deps = {
    stillToVideo: async (imageAssetId: string, audioAssetId: string) => {
      stillToVideoCalls.push({ imageAssetId, audioAssetId })
      return { assetId: `seg-${segCount++}` }
    },
    concatVideos: async (clipAssetIds: readonly string[]) => {
      concatVideosCalls.push(clipAssetIds)
      return { assetId: 'video-1' }
    },
  }

  return { ctx, calls, askUserCalls, deps, stillToVideoCalls, concatVideosCalls }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('meta_explainer-short', () => {
  it('scene clamp: text-gen returns more scenes than sceneCount → only sceneCount text-to-image calls', async () => {
    // text-gen returns 6 scenes, sceneCount=3 → only 3 t2i calls
    const { ctx, calls, deps } = makeCtx({ scenesJson: fakeScenesJson(6) })
    await createExplainerShortMeta(deps).compose(
      { input: { topic: 'quantum computing', sceneCount: 3, assemble: false } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(3)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(3)
  })

  it('form edits applied: edited narration flows into text-to-speech, others fall back to original', async () => {
    const scenesJson = fakeScenesJson(3)
    const { ctx, calls, deps } = makeCtx({
      scenesJson,
      formAnswer: {
        values: {
          scene_0: 'EDITED narration for scene 0',
          scene_1: 'narration 1', // unchanged
          scene_2: 'narration 2', // unchanged
        },
      },
    })
    const out = await createExplainerShortMeta(deps).compose(
      { input: { topic: 'photosynthesis', sceneCount: 3, assemble: false } },
      ctx,
    )
    const ttsCalls = calls.filter((c) => c.patternId === 'text-to-speech')
    expect(ttsCalls).toHaveLength(3)
    // The edited text must reach the first TTS call
    expect(ttsCalls[0].input.text).toBe('EDITED narration for scene 0')
    // The unchanged scenes use the original generated narration
    expect(ttsCalls[1].input.text).toBe('narration 1')
    expect(ttsCalls[2].input.text).toBe('narration 2')
    // The voiced narration is what the output reports back per scene.
    expect(out.scenes.map((s) => s.narration)).toEqual([
      'EDITED narration for scene 0',
      'narration 1',
      'narration 2',
    ])
  })

  it('per-scene pairing: output scenes.length === sceneCount; each scene\'s still and VO are labelled scene-<i>-image / scene-<i>-vo', async () => {
    const { ctx, deps } = makeCtx({ scenesJson: fakeScenesJson(4) })
    const out = await createExplainerShortMeta(deps).compose(
      { input: { topic: 'black holes', sceneCount: 4, assemble: false } },
      ctx,
    )
    expect(out.scenes).toHaveLength(4)
    expect(out.scenes.map((s) => s.type)).toEqual(['hook', 'concept', 'broll', 'cta'])
    for (let i = 0; i < 4; i++) {
      expect(byLabel(out, `scene-${i}-image`)).toMatchObject({ assetId: `img-${i}`, modality: 'image' })
      expect(byLabel(out, `scene-${i}-vo`)).toMatchObject({ assetId: `vo-${i}`, modality: 'audio' })
    }
    // assemble:false → 4 stills + 4 VOs and no final-video.
    expect(out.assets).toHaveLength(8)
    expect(byLabel(out, 'final-video')).toBeUndefined()
    // gen 0.02 + 4 scenes × (t2i 0.1 + tts 0.05) = 0.02 + 0.60
    expect(out.cost).toBeCloseTo(0.62)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('empty-assets guard → throws "produced no asset"', async () => {
    const { ctx, deps } = makeCtx({
      scenesJson: fakeScenesJson(2),
      ttsOverride: () => ({
        modality: 'audio' as const,
        assets: [],
        cost: 0,
        latencyMs: 0,
        model: 'm',
        provider: 'p',
      }),
    })
    await expect(
      createExplainerShortMeta(deps).compose(
        { input: { topic: 'test', sceneCount: 2, assemble: false } },
        ctx,
      ),
    ).rejects.toThrow('produced no asset')
  })

  it('malformed JSON from text-generation rejects with /did not return valid JSON/', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (_o: {
      kind: string
      payload: { fields: { key: string; value: string }[] }
    }) => ({ values: {} as Record<string, string> })
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: PatternRef): Promise<T> => {
        calls.push({ patternId: ref.patternId })
        if (ref.patternId === 'text-generation')
          return fakeTextGen('not json{') as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createExplainerShortMeta(noopDeps()).compose(
        { input: { topic: 'black holes', sceneCount: 3, assemble: false } },
        ctx,
      ),
    ).rejects.toThrow(/did not return valid JSON/)
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(0)
  })

  it('empty scenes array from text-generation rejects (Zod .min(1))', async () => {
    const { ctx, calls, deps } = makeCtx({ scenesJson: JSON.stringify({ scenes: [] }) })
    await expect(
      createExplainerShortMeta(deps).compose(
        { input: { topic: 'test', sceneCount: 2, assemble: false } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(0)
  })

  it('cancel: askUser.form bridge throws → compose rejects AND zero t2i/TTS calls fired after gate', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (_o: {
      kind: string
      payload: { fields: { key: string; value: string }[] }
    }): Promise<never> => {
      throw new Error('user cancelled form')
    }
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: PatternRef): Promise<T> => {
        calls.push({ patternId: ref.patternId })
        if (ref.patternId === 'text-generation')
          return fakeTextGen(fakeScenesJson(3)) as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createExplainerShortMeta(noopDeps()).compose(
        { input: { topic: 'gravity', sceneCount: 3, assemble: false } },
        ctx,
      ),
    ).rejects.toThrow()
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(0)
  })

  it('fires one askUser.form with one field per scene, then the cost-gate confirm', async () => {
    const { ctx, askUserCalls, deps } = makeCtx({ scenesJson: fakeScenesJson(3) })
    await createExplainerShortMeta(deps).compose(
      { input: { topic: 'gravity', sceneCount: 3, assemble: false } },
      ctx,
    )
    expect(askUserCalls.map((c) => c.kind)).toEqual(['form', 'confirm'])
    const fields = (askUserCalls[0].payload as { fields: { key: string }[] }).fields
    expect(fields).toHaveLength(3)
    expect(fields.map((f) => f.key)).toEqual(['scene_0', 'scene_1', 'scene_2'])
  })

  it('confirm=false → ZERO t2i/TTS dispatches; envelope-valid early return with empty scenes', async () => {
    const { ctx, calls } = makeCtx({
      scenesJson: fakeScenesJson(3),
      confirmAnswer: false,
    })
    const out = await createExplainerShortMeta(noopDeps()).compose(
      { input: { topic: 'gravity', sceneCount: 3, assemble: true } },
      ctx,
    )
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(0)
    expect(out.scenes).toEqual([])
    expect(out.assets).toEqual([])
    // The early return still satisfies the output schema (cost/latency required).
    expect(() => ExplainerShortOutputSchema.parse(out)).not.toThrow()
    // Decline path only bills the planning text-generation (0.02); nothing paid ran.
    expect(out.cost).toBeCloseTo(0.02)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('cancel: askUser.confirm bridge throws → compose rejects AND zero paid calls after the gate', async () => {
    const calls: Array<{ patternId: string }> = []
    const rawBridge = async (o: {
      kind: string
      payload: { fields: { key: string; value: string }[] }
    }) => {
      if (o.kind === 'form') {
        return { values: Object.fromEntries(o.payload.fields.map((f) => [f.key, f.value])) }
      }
      throw new Error('user cancelled confirm')
    }
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
      signal: new AbortController().signal,
      stepIndex: 0,
      step: async <T>(ref: PatternRef): Promise<T> => {
        calls.push({ patternId: ref.patternId })
        if (ref.patternId === 'text-generation')
          return fakeTextGen(fakeScenesJson(3)) as unknown as T
        throw new Error(`unexpected patternId ${ref.patternId}`)
      },
    } as unknown as ExecutionContext
    await expect(
      createExplainerShortMeta(noopDeps()).compose(
        { input: { topic: 'gravity', sceneCount: 3, assemble: true } },
        ctx,
      ),
    ).rejects.toThrow('user cancelled confirm')
    expect(calls.filter((c) => c.patternId === 'text-to-image')).toHaveLength(0)
    expect(calls.filter((c) => c.patternId === 'text-to-speech')).toHaveLength(0)
  })

  it('assemble (default true): stillToVideo per scene, concat over the segments, final-video labelled', async () => {
    const { ctx, deps, stillToVideoCalls, concatVideosCalls } = makeCtx({
      scenesJson: fakeScenesJson(3),
    })
    // assemble omitted → zod default of true applies
    const out = await createExplainerShortMeta(deps).compose(
      { input: { topic: 'gravity', sceneCount: 3, assemble: true } },
      ctx,
    )
    // one stillToVideo per scene, called with (scene still, scene VO)
    expect(stillToVideoCalls).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(stillToVideoCalls[i]).toEqual({
        imageAssetId: byLabel(out, `scene-${i}-image`)!.assetId,
        audioAssetId: byLabel(out, `scene-${i}-vo`)!.assetId,
      })
    }
    // concat called once with exactly the segment ids stillToVideo produced
    expect(concatVideosCalls).toHaveLength(1)
    expect([...concatVideosCalls[0]]).toEqual(['seg-0', 'seg-1', 'seg-2'])
    expect(byLabel(out, 'final-video')).toMatchObject({ assetId: 'video-1', modality: 'video' })
    expect(out.assets.at(-1)?.label).toBe('final-video')
    expect(out.scenes).toHaveLength(3)
    // gen 0.02 + 3 scenes × (t2i 0.1 + tts 0.05) = 0.02 + 0.45; host assembly adds no cost
    expect(out.cost).toBeCloseTo(0.47)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('assemble:false → neither host dep called, no final-video, scenes still returned', async () => {
    const { ctx, deps, stillToVideoCalls, concatVideosCalls } = makeCtx({
      scenesJson: fakeScenesJson(3),
    })
    const out = await createExplainerShortMeta(deps).compose(
      { input: { topic: 'gravity', sceneCount: 3, assemble: false } },
      ctx,
    )
    expect(stillToVideoCalls).toHaveLength(0)
    expect(concatVideosCalls).toHaveLength(0)
    expect(byLabel(out, 'final-video')).toBeUndefined()
    expect(out.scenes).toHaveLength(3)
    // assemble-off return path also carries cost/latency: gen 0.02 + 3 × 0.15
    expect(out.cost).toBeCloseTo(0.47)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('assembly fan-out: an 8-scene run never has more than 3 stillToVideo calls in flight', async () => {
    const { ctx } = makeCtx({ scenesJson: fakeScenesJson(8) })
    let inFlight = 0
    let peak = 0
    let segCount = 0
    const deps = {
      stillToVideo: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { assetId: `seg-${segCount++}` }
      },
      concatVideos: async () => ({ assetId: 'video-1' }),
    }
    await createExplainerShortMeta(deps).compose(
      { input: { topic: 'oceans', sceneCount: 8, assemble: true } },
      ctx,
    )
    expect(segCount).toBe(8)
    expect(peak).toBeLessThanOrEqual(3)
    // Still a fan-out, not a serialized loop.
    expect(peak).toBeGreaterThan(1)
  })

  it('assembly fan-out: out-of-order stillToVideo resolution still concats segments in scene order', async () => {
    const { ctx } = makeCtx({ scenesJson: fakeScenesJson(3) })
    const concatVideosCalls: Array<readonly string[]> = []
    const deps = {
      stillToVideo: async (imageAssetId: string) => {
        // Scene 0 resolves LAST — the segment order must still match scene order.
        await new Promise((r) => setTimeout(r, imageAssetId === 'img-0' ? 20 : 1))
        return { assetId: `seg-for-${imageAssetId}` }
      },
      concatVideos: async (clipAssetIds: readonly string[]) => {
        concatVideosCalls.push(clipAssetIds)
        return { assetId: 'video-1' }
      },
    }
    await createExplainerShortMeta(deps).compose(
      { input: { topic: 'oceans', sceneCount: 3, assemble: true } },
      ctx,
    )
    expect(concatVideosCalls).toHaveLength(1)
    expect([...concatVideosCalls[0]]).toEqual([
      'seg-for-img-0',
      'seg-for-img-1',
      'seg-for-img-2',
    ])
  })

  it('assembly fan-out: one stillToVideo rejection propagates (fast-fail) and concat never runs', async () => {
    const { ctx } = makeCtx({ scenesJson: fakeScenesJson(4) })
    const deps = {
      stillToVideo: async (imageAssetId: string) => {
        if (imageAssetId === 'img-1') throw new Error('encoder session failed')
        return { assetId: `seg-for-${imageAssetId}` }
      },
      concatVideos: async () => {
        throw new Error('concatVideos should not be called')
      },
    }
    await expect(
      createExplainerShortMeta(deps).compose(
        { input: { topic: 'oceans', sceneCount: 4, assemble: true } },
        ctx,
      ),
    ).rejects.toThrow('encoder session failed')
  })

  it('returns the produced-assets envelope: every element labelled, no raw-id field anywhere', async () => {
    const { ctx, deps } = makeCtx({ scenesJson: fakeScenesJson(2) })
    const out = await createExplainerShortMeta(deps).compose(
      { input: { topic: 'gravity', sceneCount: 2, assemble: true } },
      ctx,
    )
    expectProducedAssetsEnvelope(ExplainerShortOutputSchema, out)
    expect(out.assets.map((a) => a.label)).toEqual([
      'scene-0-image',
      'scene-0-vo',
      'scene-1-image',
      'scene-1-vo',
      'final-video',
    ])
  })

  it('declares the dispatch set an agent guard holds to its allowlist', () => {
    const meta = createExplainerShortMeta(noopDeps())
    const declared = ['text-generation', 'text-to-image', 'text-to-speech']
    // Three patterns whatever the scene count, and whether or not the scenes
    // are assembled: `stillToVideo` / `concatVideos` are host ops, not
    // dispatches, so `assemble` moves nothing here.
    expect(
      meta.plannedDispatches?.({ topic: 'black holes', sceneCount: 4, assemble: true }),
    ).toEqual(declared)
    expect(
      meta.plannedDispatches?.({ topic: 'black holes', sceneCount: 2, assemble: false }),
    ).toEqual(declared)
  })
})
