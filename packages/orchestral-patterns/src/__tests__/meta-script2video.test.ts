import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import type { AskUserGeneric, ExecutionContext, PatternRef } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import {
  createScript2VideoMeta,
  ScriptToVideoInputSchema,
  ScriptToVideoOutputSchema,
  ShotDecompositionSchema,
  type ScriptToVideoInput,
  type ScriptToVideoMetaDeps,
} from '../meta/script2video'
import { expectProducedAssetsEnvelope } from './helpers/produced-assets'
import {
  CHARACTER_EXTRACTION_PROMPT,
  PORTRAIT_FRONT_PROMPT,
  PORTRAIT_SIDE_PROMPT,
  PORTRAIT_BACK_PROMPT,
  STORYBOARD_DESIGN_PROMPT,
  SHOT_VISUAL_DECOMPOSITION_PROMPT,
  CAMERA_TREE_CONSTRUCTION_PROMPT,
  CINEMATIC_SHOT_FRAMING_PROMPT,
  I2V_SHOT_SINGLE_PROMPT,
  I2V_SHOT_TRANSITION_PROMPT,
} from '../meta/script2video/prompts'

// Image-gen + i2v atomics have no `system` slot, so the meta folds the inlined
// prompt const into the `prompt` field as a PREFIX. Routing/identification in
// these tests therefore matches the prompt prefix against the real prompt
// constants.
const promptStartsWith = (input: Record<string, unknown>, prefix: string) =>
  String((input as { prompt?: string }).prompt ?? '').startsWith(prefix)

const promptOf = (c: Call): string => String((c.input as { prompt?: string }).prompt ?? '')

/**
 * Pull the input-block tags a prompt body declares (backticked `<TAG>` /
 * `</TAG>` forms). Guards against prompt↔code tag drift: the prompt body tells
 * the model which wrappers to read, so the dispatched user prompt must emit
 * exactly those.
 */
function declaredTags(prompt: string): string[] {
  const found = new Set<string>()
  for (const m of prompt.matchAll(/`<\/?([A-Z][A-Z_]*)>`/g)) found.add(m[1])
  return [...found]
}

// compose() is typed on the parsed input — every `.default()` field present,
// which is what the chat dispatch path hands it. Fixtures are written the way
// a caller writes them and run through the schema, so the defaults are
// exercised here rather than restated in every test.
const inputOf = (i: z.input<typeof ScriptToVideoInputSchema>): ScriptToVideoInput =>
  ScriptToVideoInputSchema.parse(i)

const ALICE = {
  idx: 0,
  identifierInScene: 'Alice',
  staticFeatures: 'short hair',
  dynamicFeatures: 'green dress',
  isVisible: true,
}

// ── scripted model answers ────────────────────────────────────────────────

interface ShotFixture {
  idx: number
  is_last: boolean
  cam_idx: number
  visual_desc: string
  audio_desc: string
}
const shot = (
  idx: number,
  cam_idx: number,
  visual_desc: string,
  extra: Partial<Pick<ShotFixture, 'is_last' | 'audio_desc'>> = {},
): ShotFixture => ({ idx, is_last: false, cam_idx, visual_desc, audio_desc: '', ...extra })

type Decomposition = z.infer<typeof ShotDecompositionSchema>
const DEFAULT_DECOMPOSITION: Decomposition = {
  ff_desc: 'first frame',
  ff_vis_char_idxs: [0],
  lf_desc: 'last frame',
  lf_vis_char_idxs: [0],
  motion_desc: 'pan left',
  variation_type: 'small',
}

// Camera-tree entries as the prompt now asks for them: every entry echoes the
// cam_idx it answers for; a root is null parent fields, not a null entry.
const rootCam = (cam_idx: number) => ({
  cam_idx,
  parent_cam_idx: null,
  parent_shot_idx: null,
  is_parent_fully_covers_child: null,
  missing_info: null,
})
const childCam = (
  cam_idx: number,
  parent_cam_idx: number,
  parent_shot_idx: number,
  missing_info: string,
) => ({
  cam_idx,
  parent_cam_idx,
  parent_shot_idx,
  reason: 'the parent covers the child',
  is_parent_fully_covers_child: false,
  missing_info,
})

// ── fake ctx ──────────────────────────────────────────────────────────────

// Recorded shape per ctx.step call. `assets` carries the internal-asset
// channel (ref.assets) — source/reference/startFrame/endFrame flow there by
// assetId, not through input.references. `producedAssetId` is what the fake
// handed back for an image/video call, so a later call's slot can be matched
// to the call that produced it.
interface Call {
  patternId: string
  input: Record<string, unknown>
  assets: PatternRef['assets']
  producedAssetId?: string
}

// Fixed per-patternId cost so the meta's accumulated `out.cost` is countable
// straight from the recorded `calls`. Every paid atomic dispatch flows through
// ctx.step (recorded); the host concatVideos runs via ctx.compute and adds no
// cost, so summing these over `calls` reproduces compose's cost total exactly.
const COST_BY_PATTERN: Record<string, number> = {
  'text-generation': 0.01,
  'text-to-image': 0.1,
  'image-to-image': 0.1,
  'image-to-video': 0.2,
}

// Sum the fixed per-patternId costs over the recorded atomic dispatches.
const expectedCost = (calls: ReadonlyArray<Call>): number =>
  calls.reduce((sum, c) => sum + (COST_BY_PATTERN[c.patternId] ?? 0), 0)

const PAID_RENDERS = new Set(['text-to-image', 'image-to-image', 'image-to-video'])
const renderCalls = (calls: ReadonlyArray<Call>) => calls.filter((c) => PAID_RENDERS.has(c.patternId))

interface CtxOptions {
  /** Storyboard the design step returns (default: two shots on camera 0). */
  storyboard?: ShotFixture[]
  /** Per-shot decomposition overrides, looked up by the shot's visual_desc. */
  decompositionFor?: (visualDesc: string) => Partial<Decomposition>
  /** Camera-tree answer (default: camera 0 is the root). */
  cameraTree?: unknown[]
  /** What stage 1 extracts when no characters were supplied (default: none). */
  extractedCharacters?: unknown[]
  /** Answer to the render-gate confirm (default: confirmed). */
  confirmAnswer?: boolean
}

// Routing fake: the meta bakes the real inlined prompt bodies into the
// text-generation `system` field, so text-generation routes by matching
// `system` against the exported prompt constants; image/video calls hand back
// a counter-numbered asset. `timeline` interleaves step dispatches with
// askUser parks so a test can assert what ran before the gate.
function makeCtx(opts: CtxOptions = {}) {
  const calls: Array<Call> = []
  const askUserCalls: Array<{ kind: string; payload: unknown }> = []
  const timeline: string[] = []
  let asset = 0
  const storyboard = opts.storyboard ?? [
    shot(0, 0, 'shot A'),
    shot(1, 0, 'shot B', { is_last: true }),
  ]
  const cameraTree = opts.cameraTree ?? [rootCam(0)]
  const text = (obj: unknown) => ({
    modality: 'text' as const,
    text: JSON.stringify(obj),
    cost: COST_BY_PATTERN['text-generation']!,
    latencyMs: 5,
    model: 'm',
    provider: 'p',
  })
  const produced = (call: Call, prefix: string, modality: 'image' | 'video') => {
    asset += 1
    const assetId = `${prefix}-id${asset}`
    call.producedAssetId = assetId
    return {
      modality,
      assets: [{ handle: `${prefix}-h${asset}`, assetId, modality }],
      cost: COST_BY_PATTERN[call.patternId]!,
      latencyMs: 5,
      model: 'm',
      provider: 'p',
    }
  }
  const rawBridge = async (o: { kind: string; payload: unknown }) => {
    askUserCalls.push({ kind: o.kind, payload: o.payload })
    timeline.push(`ask:${o.kind}`)
    if (o.kind === 'confirm') return { confirmed: opts.confirmAnswer ?? true }
    throw new Error(`unexpected askUser kind ${o.kind}`)
  }
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    askUser: buildAskUserFacade(rawBridge as unknown as AskUserGeneric),
    signal: new AbortController().signal,
    stepIndex: 0,
    step: async <T>(ref: PatternRef): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      const call: Call = { patternId: ref.patternId, input, assets: ref.assets }
      calls.push(call)
      timeline.push(`step:${ref.patternId}`)
      if (ref.patternId === 'text-generation') {
        const sys = String(input.system)
        if (sys === STORYBOARD_DESIGN_PROMPT) return text({ storyboard }) as unknown as T
        if (sys === SHOT_VISUAL_DECOMPOSITION_PROMPT) {
          const visualDesc =
            /<VISUAL_DESC>\n([\s\S]*?)\n<\/VISUAL_DESC>/.exec(String(input.prompt))?.[1] ?? ''
          return text({
            ...DEFAULT_DECOMPOSITION,
            ...(opts.decompositionFor?.(visualDesc) ?? {}),
          }) as unknown as T
        }
        if (sys === CAMERA_TREE_CONSTRUCTION_PROMPT) {
          return text({ camera_parent_items: cameraTree }) as unknown as T
        }
        return text({ characters: opts.extractedCharacters ?? [] }) as unknown as T
      }
      if (ref.patternId === 'text-to-image') return produced(call, 'img', 'image') as unknown as T
      if (ref.patternId === 'image-to-image') return produced(call, 'i2i', 'image') as unknown as T
      return produced(call, 'vid', 'video') as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, calls, askUserCalls, timeline }
}

const concatFake = () =>
  vi.fn(async (ids: readonly string[]) => ({ assetId: `final[${ids.join(',')}]` }))

describe('meta_script2video', () => {
  it('returns the produced-assets envelope: one labelled final-video, no raw-id field anywhere', async () => {
    const meta = createScript2VideoMeta({ concatVideos: async () => ({ assetId: 'final' }) })
    const { ctx } = makeCtx()
    const out = await meta.compose(
      { input: inputOf({ sceneScript: 'a short scene', characters: [] }) },
      ctx,
    )
    expectProducedAssetsEnvelope(ScriptToVideoOutputSchema, out)
    expect(out.assets.map((a) => a.label)).toEqual(['final-video'])
  })

  it('runs the 8-stage DAG and concatenates the per-shot clips', async () => {
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls, askUserCalls } = makeCtx()

    const out = await meta.compose(
      // pre-supply one visible character so stage 1 is skipped.
      { input: inputOf({ sceneScript: 'a short scene', characters: [ALICE] }) },
      ctx,
    )

    // 2 shots → 2 frames, 2 clips. 1 visible character → 3 portraits (front
    // t2i + side i2i + back i2i). Concatenated in order.
    expect(out.shotCount).toBe(2)
    expect(concatVideos).toHaveBeenCalledTimes(1)
    const concatArg = concatVideos.mock.calls[0][0]
    expect(concatArg).toHaveLength(2)
    expect(out.assets).toEqual([
      { assetId: `final[${concatArg.join(',')}]`, modality: 'video', label: 'final-video' },
    ])

    // Meta envelope — accumulated cost is the sum over every paid atomic
    // dispatch (host concatVideos runs via ctx.compute and adds nothing);
    // latency is a non-negative wall-clock delta.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // One render gate, confirmed.
    expect(askUserCalls.map((c) => c.kind)).toEqual(['confirm'])

    // Stage 1 skipped (characters provided) → no character-extraction text step.
    const charSteps = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === CHARACTER_EXTRACTION_PROMPT,
    )
    expect(charSteps).toHaveLength(0)

    // Stage 5 — 3 portrait calls per visible character: 1 t2i (front, prompt
    // prefixed with PORTRAIT_FRONT_PROMPT) and 2 i2i (side + back, each ref =
    // front portrait handle).
    const portraitTextToImage = calls.filter(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, PORTRAIT_FRONT_PROMPT),
    )
    expect(portraitTextToImage).toHaveLength(1)
    const portraitImageToImage = calls.filter((c) => c.patternId === 'image-to-image')
    expect(portraitImageToImage).toHaveLength(2)
    for (const p of portraitImageToImage) {
      // Side and back both source the front portrait's assetId via the
      // internal-asset channel (slot 'source'), not input.references.
      expect(p.input.references).toBeUndefined()
      expect(p.assets).toEqual([
        { slot: 'source', assetId: 'img-id1', modality: 'image' },
      ])
    }

    // Stage 6 — frame steps (prompt prefixed with CINEMATIC_SHOT_FRAMING_PROMPT)
    // carry all 3 portrait views (front + side + back) as identity references so
    // the t2i model can pick the matching angle — by assetId via ref.assets,
    // slot 'reference'.
    const frameCalls = calls.filter(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )
    expect(frameCalls).toHaveLength(2)
    for (const f of frameCalls) {
      expect(f.input.references).toBeUndefined()
      const refs = f.assets ?? []
      expect(refs).toHaveLength(3) // front + side + back
      expect(refs.every((a) => a.slot === 'reference' && a.modality === 'image')).toBe(true)
      expect(refs[0]!.assetId).toBe('img-id1') // front from t2i (assetId)
      expect(refs[1]!.assetId).toMatch(/^i2i-id/) // side from i2i (assetId)
      expect(refs[2]!.assetId).toMatch(/^i2i-id/) // back from i2i (assetId)
    }

    // Stage 7 — each video animates from a first-frame assetId (slot
    // 'startFrame' via ref.assets), prompt prefixed with I2V_SHOT_SINGLE_PROMPT.
    // Small-variation shots carry no endFrame.
    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(2)
    for (const v of videoCalls) {
      expect(v.input.references).toBeUndefined()
      expect(v.assets).toHaveLength(1)
      expect(v.assets![0]!.slot).toBe('startFrame')
      expect(v.assets![0]!.assetId).toMatch(/^img-id/)
      expect(promptStartsWith(v.input, I2V_SHOT_SINGLE_PROMPT)).toBe(true)
    }
  })

  it('feeds userRequirement and the shot bound to the storyboard step under <USER_REQUIREMENT> (the tag the prompt reads)', async () => {
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    const storyboardPromptOf = (calls: ReadonlyArray<Call>) =>
      promptOf(
        calls.find(
          (c) =>
            c.patternId === 'text-generation' &&
            String(c.input.system) === STORYBOARD_DESIGN_PROMPT,
        )!,
      )

    const withReq = makeCtx()
    await meta.compose(
      {
        input: inputOf({
          sceneScript: 'a short scene',
          userRequirement: 'no more than 4 shots',
          characters: [ALICE],
          maxShots: 6,
        }),
      },
      withReq.ctx,
    )
    // STORYBOARD_DESIGN_PROMPT reads <USER_REQUIREMENT>; a <REQUIREMENT> tag
    // was never matched so the requirement was silently dropped. The shot
    // bound rides in the same block — the prompt lists "desired number of
    // shots" as one of the things that block carries.
    const prompt = storyboardPromptOf(withReq.calls)
    expect(prompt).toContain(
      '<USER_REQUIREMENT>\nno more than 4 shots\nUse at most 6 shots.\n</USER_REQUIREMENT>',
    )
    expect(prompt).not.toContain('<REQUIREMENT>')

    // No user requirement: the block still carries the bound (default 12).
    const noReq = makeCtx()
    await meta.compose(
      { input: inputOf({ sceneScript: 'a short scene', characters: [ALICE] }) },
      noReq.ctx,
    )
    expect(storyboardPromptOf(noReq.calls)).toContain(
      '<USER_REQUIREMENT>\nUse at most 12 shots.\n</USER_REQUIREMENT>',
    )
  })

  // Camera-tree-construction is dispatched and its output drives Stage 6:
  // child shots route through image-to-image primary with their parent's
  // first frame as `source` instead of text-to-image with the portrait
  // registry.
  it('routes child shots through image-to-image with parent frame as source', async () => {
    const { ctx, calls } = makeCtx({
      // 3 shots: cam 0 (root) → cam 1 (child of cam 0) → cam 0 again
      storyboard: [
        shot(0, 0, 'wide street, Alice walking'),
        shot(1, 1, "close-up Alice's face"),
        shot(2, 0, 'wide street, Alice approaches Bob', { is_last: true }),
      ],
      decompositionFor: () => ({ ff_desc: 'frame description' }),
      // cam 0 is the root; cam 1's parent is cam 0, shot 0.
      cameraTree: [rootCam(0), childCam(1, 0, 0, "frontal view of Alice's face")],
    })
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })

    const out = await meta.compose(
      { input: inputOf({ sceneScript: 'a scene with close-up cut', characters: [ALICE] }) },
      ctx,
    )

    expect(out.shotCount).toBe(3)

    // Meta envelope — cost sums every paid atomic dispatch (incl. the child
    // shot's image-to-image frame), latency is non-negative.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // Camera-tree-construction was dispatched with the <CAMERA_SEQ> shape the
    // prompt body mandates.
    const cameraTreeCalls = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === CAMERA_TREE_CONSTRUCTION_PROMPT,
    )
    expect(cameraTreeCalls).toHaveLength(1)
    const ctPrompt = promptOf(cameraTreeCalls[0]!)
    expect(ctPrompt).toContain('<CAMERA_SEQ>')
    expect(ctPrompt).toContain('<CAMERA_0>')
    expect(ctPrompt).toContain('<CAMERA_1>')
    expect(ctPrompt).toContain('Shot 0:')
    expect(ctPrompt).toContain('Shot 1:')
    expect(ctPrompt).toContain('Shot 2:')

    // Stage 6 — frame dispatches (prompt prefixed with CINEMATIC_SHOT_FRAMING_PROMPT).
    //   shot 0 (cam 0, root): text-to-image with portraits
    //   shot 1 (cam 1, parent=cam 0 shot 0): image-to-image with shot 0's frame as source
    //   shot 2 (cam 0, root again): text-to-image with portraits
    const frameTextCalls = calls.filter(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )
    // 2 root shots → 2 text-to-image calls (shot 0 + shot 2). Portraits feed
    // the 'reference' slot by assetId via ref.assets, not input.references.
    expect(frameTextCalls).toHaveLength(2)
    for (const f of frameTextCalls) {
      expect(f.input.references).toBeUndefined()
      const refs = f.assets ?? []
      expect(refs).toHaveLength(3) // front + side + back portraits
      expect(refs.every((a) => a.slot === 'reference')).toBe(true)
    }

    // 1 child shot → 1 image-to-image call WITH the framing prompt prefix.
    // (The portrait stage's image-to-image calls also exist but their prompt is
    //  prefixed with PORTRAIT_SIDE/BACK, not CINEMATIC_SHOT_FRAMING.)
    const frameI2iCalls = calls.filter(
      (c) =>
        c.patternId === 'image-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )
    expect(frameI2iCalls).toHaveLength(1)
    const childCall = frameI2iCalls[0]!
    // Child's source = parent shot's frame assetId, fed via the internal-asset
    // channel (slot 'source'), not input.references. Sequence:
    //   portrait-front (img-id1), portrait-side (i2i-id2), portrait-back (i2i-id3),
    //   shot 0 frame (img-id4), then child shot 1 sources img-id4.
    expect(childCall.input.references).toBeUndefined()
    expect(childCall.assets).toEqual([
      { slot: 'source', assetId: 'img-id4', modality: 'image' },
    ])
    // Prompt has the camera-tree missing_info hint appended.
    expect(promptOf(childCall)).toContain('[Camera-tree hint]')
    expect(promptOf(childCall)).toContain('frontal view')

    // Stage 7 — 3 video clips, each animating from a frame.
    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(3)
  })

  // transitionMode: 'between-shots' inserts N-1 transition clips between
  // adjacent shots and interleaves them into concat order.
  it('renders N-1 transition clips and interleaves when transitionMode=between-shots', async () => {
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      {
        input: inputOf({
          sceneScript: 'two shots',
          characters: [ALICE],
          transitionMode: 'between-shots',
        }),
      },
      ctx,
    )

    // makeCtx() returns 2 shots → 2 single-shot i2v calls + 1 transition.
    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(3)
    expect(out.shotCount).toBe(2)

    // Meta envelope — cost sums every paid atomic dispatch (incl. the extra
    // transition i2v clip), latency is non-negative.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // Identify the transition call by its prompt prefix — only it is prefixed
    // with I2V_SHOT_TRANSITION_PROMPT. Single-shot calls use I2V_SHOT_SINGLE_PROMPT.
    const transitionCalls = videoCalls.filter((c) =>
      promptStartsWith(c.input, I2V_SHOT_TRANSITION_PROMPT),
    )
    expect(transitionCalls).toHaveLength(1)
    const singleShotCalls = videoCalls.filter((c) =>
      promptStartsWith(c.input, I2V_SHOT_SINGLE_PROMPT),
    )
    expect(singleShotCalls).toHaveLength(2)

    // The transition prefix names the cut; the two shots' visual descriptions
    // follow verbatim from the storyboard ("shot A" / "shot B" per makeCtx).
    const tPrompt = promptOf(transitionCalls[0]!)
    expect(tPrompt).toContain('hard cut')
    expect(tPrompt).toContain('First shot: shot A')
    expect(tPrompt).toContain('Second shot: shot B')

    // Transition startFrame = first shot's first-frame assetId (the same
    // assetId used by single-shot 0's startFrame), via the internal-asset
    // channel (slot 'startFrame').
    const startFrameOf = (c: Call): string => {
      expect(c.input.references).toBeUndefined()
      expect(c.assets).toHaveLength(1)
      expect(c.assets![0]!.slot).toBe('startFrame')
      return c.assets![0]!.assetId
    }
    expect(startFrameOf(transitionCalls[0]!)).toBe(
      startFrameOf(singleShotCalls[0]!),
    )

    // Concat receives 3 clips interleaved [shot0, trans0, shot1].
    expect(concatVideos).toHaveBeenCalledTimes(1)
    expect(concatVideos.mock.calls[0][0]).toHaveLength(3)
  })

  it('falls back to single-shot path when transitionMode=between-shots but storyboard has < 2 shots', async () => {
    const { ctx, calls } = makeCtx({
      storyboard: [shot(0, 0, 'lone shot', { is_last: true })],
    })
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })

    await meta.compose(
      {
        input: inputOf({
          sceneScript: 'single shot scene',
          characters: [ALICE],
          transitionMode: 'between-shots',
        }),
      },
      ctx,
    )

    // No adjacent pair to transition between → 0 transition clips, 1 single.
    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(1)
    const transitionCalls = videoCalls.filter((c) =>
      promptStartsWith(c.input, I2V_SHOT_TRANSITION_PROMPT),
    )
    expect(transitionCalls).toHaveLength(0)
    expect(concatVideos.mock.calls[0][0]).toHaveLength(1)
  })

  it('keeps the single-shot path when transitionMode is omitted (schema default "none")', async () => {
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const input = inputOf({ sceneScript: 'two shots, no transitions', characters: [ALICE] })
    // `.default('none')` with no trailing `.optional()`: the parsed value is
    // the enum, never undefined.
    expect(input.transitionMode).toBe('none')
    await meta.compose({ input }, ctx)

    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(2) // 2 single shots, 0 transitions
    const transitionCalls = videoCalls.filter((c) =>
      promptStartsWith(c.input, I2V_SHOT_TRANSITION_PROMPT),
    )
    expect(transitionCalls).toHaveLength(0)
    expect(concatVideos.mock.calls[0][0]).toHaveLength(2)
  })

  it('emits the input tags shot-visual-decomposition declares, with the indexed character list', async () => {
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    const { ctx, calls } = makeCtx()

    await meta.compose(
      {
        input: inputOf({
          sceneScript: 'a short scene',
          characters: [
            ALICE,
            {
              idx: 1,
              identifierInScene: 'Bob',
              staticFeatures: 'tall',
              dynamicFeatures: 'blue shirt',
              isVisible: true,
            },
            {
              idx: 2,
              identifierInScene: 'the narrator',
              staticFeatures: 'unseen',
              dynamicFeatures: '',
              isVisible: false,
            },
          ],
        }),
      },
      ctx,
    )

    const decomposeCalls = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === SHOT_VISUAL_DECOMPOSITION_PROMPT,
    )
    expect(decomposeCalls).toHaveLength(2) // one per storyboard shot

    // The prompt body declares <VISUAL_DESC> + <CHARACTERS>; the dispatched
    // user prompt must emit exactly those (it used to send <SHOT> and drop the
    // character list entirely, which desynced ff_vis_char_idxs from the
    // portrait registry).
    const tags = declaredTags(SHOT_VISUAL_DECOMPOSITION_PROMPT)
    expect(tags.sort()).toEqual(['CHARACTERS', 'VISUAL_DESC'])
    for (const call of decomposeCalls) {
      const prompt = promptOf(call)
      for (const tag of tags) {
        expect(prompt).toContain(`<${tag}>`)
        expect(prompt).toContain(`</${tag}>`)
      }
      expect(prompt).not.toContain('<SHOT>')
      // Visible characters are listed under their own extraction index (the
      // index the model reports back in ff_vis_char_idxs); off-screen ones
      // cannot appear in a frame and are omitted.
      expect(prompt).toContain('#0 Alice: short hair green dress')
      expect(prompt).toContain('#1 Bob: tall blue shirt')
      expect(prompt).not.toContain('the narrator')
    }
    expect(promptOf(decomposeCalls[0]!)).toContain('<VISUAL_DESC>\nshot A\n</VISUAL_DESC>')
    expect(promptOf(decomposeCalls[1]!)).toContain('<VISUAL_DESC>\nshot B\n</VISUAL_DESC>')
  })

  it('extracts characters via text-generation when none are supplied', async () => {
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      { input: inputOf({ sceneScript: 'A hero walks into a field.' }) },
      ctx,
    )

    const charExtract = calls.find(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === CHARACTER_EXTRACTION_PROMPT,
    )
    expect(charExtract).toBeDefined()

    // Cost includes the stage-1 character-extraction text-generation dispatch
    // (unique to this no-characters path); latency is non-negative.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('malformed JSON from a runText step rejects with the labeled error (not a raw SyntaxError)', async () => {
    const concatVideos = vi.fn(async () => ({ assetId: 'x' }))
    const meta = createScript2VideoMeta({ concatVideos })
    const calls: Array<Call> = []
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(ref: PatternRef): Promise<T> => {
        const input = ref.input as Record<string, unknown>
        calls.push({ patternId: ref.patternId, input, assets: ref.assets })
        // Stage 1 character extraction gets malformed JSON back.
        return {
          modality: 'text',
          text: 'not json{',
          cost: COST_BY_PATTERN['text-generation']!,
          latencyMs: 5,
          model: 'm',
          provider: 'p',
        } as unknown as T
      },
    } as unknown as ExecutionContext

    await expect(
      meta.compose({ input: inputOf({ sceneScript: 'A hero walks into a field.' }) }, ctx),
    ).rejects.toThrow('script2video: characters: text-generation did not return valid JSON')

    // The failed parse short-circuits before any paid image/video dispatch.
    expect(renderCalls(calls)).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })

  it('declares a meta Pattern with stable id, kind, and tool surface', () => {
    const concatVideos = vi.fn(async () => ({ assetId: 'x' }))
    const meta = createScript2VideoMeta({ concatVideos } as ScriptToVideoMetaDeps)
    expect(meta.id).toBe('meta_script2video')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.tool.description).toBeTruthy()
  })

  // ── (a) every requested decomposition field is consumed ─────────────────

  it("sends the storyboard's audio_desc to the video model after the motion line, tags intact", async () => {
    const { ctx, calls } = makeCtx({
      storyboard: [
        shot(0, 0, 'shot A', { audio_desc: '[Speaker] Alice (Happy): "Hello"' }),
        shot(1, 0, 'shot B', { is_last: true }),
      ],
    })
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await meta.compose(
      { input: inputOf({ sceneScript: 'a line of dialogue', characters: [ALICE] }) },
      ctx,
    )

    // The prompt is the prefix, then `motion_desc` and `audio_desc` joined by
    // one newline — the [Speaker] tag reaches the video model's audio head
    // verbatim. Stage 7 used to send the motion line alone, so every shot
    // rendered silent no matter what the storyboard scripted.
    const [clipA, clipB] = calls.filter((c) => c.patternId === 'image-to-video')
    expect(promptOf(clipA!)).toBe(
      `${I2V_SHOT_SINGLE_PROMPT}\n\npan left\n[Speaker] Alice (Happy): "Hello"`,
    )
    // An empty audio_desc adds nothing — no dangling newline.
    expect(promptOf(clipB!)).toBe(`${I2V_SHOT_SINGLE_PROMPT}\n\npan left`)
  })

  it('renders a last frame for a medium/large variation and hands it to image-to-video as endFrame; small shots get none', async () => {
    const { ctx, calls } = makeCtx({
      decompositionFor: (visualDesc) =>
        visualDesc === 'shot A'
          ? { variation_type: 'medium', lf_desc: 'last frame of A', lf_vis_char_idxs: [0] }
          : {},
    })
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await meta.compose(
      { input: inputOf({ sceneScript: 'a turn to camera', characters: [ALICE] }) },
      ctx,
    )

    // 3 frame renders: A first, A last, B first — the last frame takes the
    // same path as the first (root camera → text-to-image with the portraits
    // of the characters visible at the end).
    const frameCalls = calls.filter(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )
    expect(frameCalls).toHaveLength(3)
    const lastFrameCall = frameCalls.find((c) => promptOf(c).includes('last frame of A'))
    expect(lastFrameCall).toBeDefined()
    expect((lastFrameCall!.assets ?? []).map((a) => a.slot)).toEqual([
      'reference',
      'reference',
      'reference',
    ])

    const [clipA, clipB] = calls.filter((c) => c.patternId === 'image-to-video')
    // Shot A: startFrame = its first frame, endFrame = the rendered last frame.
    expect(clipA!.assets!.map((a) => a.slot)).toEqual(['startFrame', 'endFrame'])
    expect(clipA!.assets![1]!.assetId).toBe(lastFrameCall!.producedAssetId)
    expect(clipA!.assets![0]!.assetId).not.toBe(lastFrameCall!.producedAssetId)
    // Shot B (small): first frame only.
    expect(clipB!.assets!.map((a) => a.slot)).toEqual(['startFrame'])
  })

  it('every field the decomposition schema asks the model for is read by index.ts', () => {
    // Source-level guard, in the spirit of the runtime's error-code scan: the
    // model is paid for every key the schema requires, so a key nothing reads
    // is spend with no consumer. Comments are stripped first — a mention in
    // prose is not a reader.
    const src = readFileSync(new URL('../meta/script2video/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const keys = Object.keys(ShotDecompositionSchema.shape)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      // A reader is a property access off a parsed decomposition
      // (`d.lf_desc`); the schema's own `lf_desc: z.string()` line is not one.
      expect(src, `${key} is requested from the model but nothing reads it`).toMatch(
        new RegExp(`\\.${key}\\b`),
      )
    }
  })

  // ── (b) render prompts address the image/video model, not an LLM ────────

  it('render prompts are direct image/video prompts — no LLM brief, no template-of-a-template', () => {
    const renderPrompts = {
      PORTRAIT_FRONT_PROMPT,
      PORTRAIT_SIDE_PROMPT,
      PORTRAIT_BACK_PROMPT,
      CINEMATIC_SHOT_FRAMING_PROMPT,
      I2V_SHOT_SINGLE_PROMPT,
      I2V_SHOT_TRANSITION_PROMPT,
    }
    for (const [name, body] of Object.entries(renderPrompts)) {
      // These go verbatim into a diffusion / video model's `prompt`. A
      // section header, the word "prompt", or second-person address means
      // the text is briefing an LLM that never runs.
      expect(body, name).not.toMatch(/\[(Role|Task|Input|Output|Guidelines)\]/)
      expect(body, name).not.toMatch(/\bprompt\b/i)
      expect(body, name).not.toMatch(/\byou (are|will|generate|author|may|must)\b/i)
      expect(body, name).not.toMatch(/[{<](identifier|features|style|motion_desc|audio_desc|ff_desc)[}>]/)
    }
    // The planning prompts are LLM-facing and keep their sections — the
    // distinction is the point.
    for (const body of [
      CHARACTER_EXTRACTION_PROMPT,
      SHOT_VISUAL_DECOMPOSITION_PROMPT,
      CAMERA_TREE_CONSTRUCTION_PROMPT,
    ]) {
      expect(body).toMatch(/\[Output\]/)
    }
  })

  it('the portrait and frame prompts carry the visual specifics after the prefix', async () => {
    const { ctx, calls } = makeCtx()
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await meta.compose(
      { input: inputOf({ sceneScript: 'a short scene', characters: [ALICE], style: 'noir' }) },
      ctx,
    )

    const front = calls.find(
      (c) => c.patternId === 'text-to-image' && promptStartsWith(c.input, PORTRAIT_FRONT_PROMPT),
    )!
    const frontPrompt = promptOf(front)
    expect(frontPrompt).toContain('front-view portrait')
    expect(frontPrompt).toContain('pure white background')
    expect(frontPrompt).toContain('Character: Alice')
    expect(frontPrompt).toContain('Features: short hair green dress')
    expect(frontPrompt).toContain('Style: noir')

    const [side, back] = calls.filter((c) => c.patternId === 'image-to-image')
    expect(promptOf(side!)).toBe(`${PORTRAIT_SIDE_PROMPT}\n\nCharacter: Alice`)
    expect(promptOf(back!)).toBe(`${PORTRAIT_BACK_PROMPT}\n\nCharacter: Alice`)

    // A root frame: prefix, then a legend tying the attached reference images
    // to the character they belong to, then the frame description and style.
    const frame = calls.find(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )!
    expect(promptOf(frame)).toBe(
      `${CINEMATIC_SHOT_FRAMING_PROMPT}\n\nReference images: images 0-2 are Alice (front, side, back).\n\nfirst frame\n\nStyle: noir`,
    )
  })

  // ── (c) the camera tree is keyed by cam_idx, never by position ──────────

  it('keys the camera tree by cam_idx: a sparse [0, 2] storyboard routes camera 2 through its parent', async () => {
    const { ctx, calls } = makeCtx({
      storyboard: [
        shot(0, 0, 'wide street'),
        shot(1, 2, 'close-up on Alice', { is_last: true }),
      ],
      // Two entries for cameras 0 and 2. Read positionally, `items[2]` is
      // undefined and the close-up quietly rendered as a root.
      cameraTree: [rootCam(0), childCam(2, 0, 0, 'frontal view of Alice')],
    })
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await meta.compose(
      { input: inputOf({ sceneScript: 'sparse cameras', characters: [ALICE] }) },
      ctx,
    )

    // The camera-tree prompt names the storyboard's own indices, gap included.
    const ctPrompt = promptOf(
      calls.find(
        (c) =>
          c.patternId === 'text-generation' &&
          String(c.input.system) === CAMERA_TREE_CONSTRUCTION_PROMPT,
      )!,
    )
    expect(ctPrompt).toContain('<CAMERA_0>')
    expect(ctPrompt).toContain('<CAMERA_2>')
    expect(ctPrompt).not.toContain('<CAMERA_1>')

    // The camera-2 shot is a child: image-to-image off shot 0's frame.
    const childFrames = calls.filter(
      (c) =>
        c.patternId === 'image-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )
    expect(childFrames).toHaveLength(1)
    const rootFrame = calls.find(
      (c) =>
        c.patternId === 'text-to-image' &&
        promptStartsWith(c.input, CINEMATIC_SHOT_FRAMING_PROMPT),
    )!
    expect(childFrames[0]!.assets).toEqual([
      { slot: 'source', assetId: rootFrame.producedAssetId, modality: 'image' },
    ])
    expect(promptOf(childFrames[0]!)).toContain('frontal view of Alice')
  })

  it('fails closed when the camera tree omits a camera the storyboard uses: coded error, nothing rendered', async () => {
    const { ctx, calls, askUserCalls } = makeCtx({
      storyboard: [shot(0, 0, 'wide street'), shot(1, 2, 'close-up', { is_last: true })],
      cameraTree: [rootCam(0)],
    })
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })

    const err = await meta
      .compose({ input: inputOf({ sceneScript: 'sparse cameras', characters: [ALICE] }) }, ctx)
      .then(
        () => undefined,
        (e: unknown) => e as Error & { code?: string },
      )
    expect(err).toBeDefined()
    expect(err!.code).toBe('SCRIPT2VIDEO_CAMERA_TREE_INCOMPLETE')
    expect(err!.message).toMatch(/^SCRIPT2VIDEO_CAMERA_TREE_INCOMPLETE: /)
    expect(err!.message).toContain('cam_idx 2')

    // Refused before the gate and before any paid render.
    expect(askUserCalls).toHaveLength(0)
    expect(renderCalls(calls)).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })

  it('fails closed when the camera tree answers for one camera twice', async () => {
    const { ctx, calls } = makeCtx({
      cameraTree: [rootCam(0), rootCam(0)],
    })
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await expect(
      meta.compose({ input: inputOf({ sceneScript: 'x', characters: [ALICE] }) }, ctx),
    ).rejects.toMatchObject({ code: 'SCRIPT2VIDEO_CAMERA_TREE_DUPLICATE' })
    expect(renderCalls(calls)).toHaveLength(0)
  })

  // ── (d) spend is bounded and confirmed before the first paid render ─────

  it('refuses a storyboard longer than maxShots with a coded error before any render or gate', async () => {
    const { ctx, calls, askUserCalls } = makeCtx() // two shots
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })

    const err = await meta
      .compose(
        { input: inputOf({ sceneScript: 'a long scene', characters: [ALICE], maxShots: 1 }) },
        ctx,
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error & { code?: string },
      )
    expect(err).toBeDefined()
    expect(err!.code).toBe('SCRIPT2VIDEO_SHOT_CAP_EXCEEDED')
    expect(err!.message).toContain('2 shots')
    expect(err!.message).toContain('maxShots is 1')

    // Only the storyboard text step ran: no decomposition, no gate, no render.
    expect(calls.map((c) => c.patternId)).toEqual(['text-generation'])
    expect(askUserCalls).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })

  it('asks one confirm stating the exact counts, after every planning step and before the first paid render', async () => {
    const { ctx, askUserCalls, timeline } = makeCtx({
      decompositionFor: (visualDesc) =>
        visualDesc === 'shot A' ? { variation_type: 'large' } : {},
    })
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    await meta.compose(
      {
        input: inputOf({
          sceneScript: 'two shots',
          characters: [ALICE],
          transitionMode: 'between-shots',
        }),
      },
      ctx,
    )

    // 1 visible character → 3 portraits; 2 shots + 1 last frame → 3 frames;
    // 2 shots + 1 transition → 3 clips.
    expect(askUserCalls).toHaveLength(1)
    const payload = askUserCalls[0]!.payload as { title: string; body: string }
    expect(askUserCalls[0]!.kind).toBe('confirm')
    expect(payload.title).toBe('Render 3 portraits, 3 frames, and 3 clips?')
    expect(payload.body).toContain('Alice')
    expect(payload.body).toContain('1. [cam 0] shot A (+ last frame)')
    expect(payload.body).toContain('2. [cam 0] shot B')
    expect(payload.body).not.toContain('shot B (+ last frame)')

    // Ordering: every text-generation step precedes the gate; every paid
    // image/video step follows it. Portraits in particular no longer render
    // before the storyboard exists.
    const gateAt = timeline.indexOf('ask:confirm')
    expect(gateAt).toBeGreaterThan(0)
    for (const [i, entry] of timeline.entries()) {
      if (entry === 'step:text-generation') expect(i).toBeLessThan(gateAt)
      if (entry.startsWith('step:') && entry !== 'step:text-generation') {
        expect(i).toBeGreaterThan(gateAt)
      }
    }
  })

  it('declined gate → no paid render, empty assets, shotCount 0, cost = planning only', async () => {
    const { ctx, calls, askUserCalls } = makeCtx({ confirmAnswer: false })
    const concatVideos = concatFake()
    const meta = createScript2VideoMeta({ concatVideos })

    const out = await meta.compose(
      { input: inputOf({ sceneScript: 'two shots', characters: [ALICE] }) },
      ctx,
    )

    expect(askUserCalls.map((c) => c.kind)).toEqual(['confirm'])
    expect(renderCalls(calls)).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
    expect(out.assets).toEqual([])
    expect(out.shotCount).toBe(0)
    expect(ScriptToVideoOutputSchema.safeParse(out).success).toBe(true)
    // The planning calls were still paid for; the declined run reports them.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
  })

  it('confirmBeforeRender: false skips the gate for a headless caller and renders', async () => {
    const { ctx, calls, askUserCalls } = makeCtx()
    const meta = createScript2VideoMeta({ concatVideos: concatFake() })
    const out = await meta.compose(
      {
        input: inputOf({
          sceneScript: 'two shots',
          characters: [ALICE],
          confirmBeforeRender: false,
        }),
      },
      ctx,
    )
    expect(askUserCalls).toHaveLength(0)
    expect(out.shotCount).toBe(2)
    expect(renderCalls(calls).length).toBeGreaterThan(0)
  })

  it('schema defaults: maxShots 12, transitionMode "none", confirmBeforeRender true; maxShots is bounded', () => {
    const parsed = inputOf({ sceneScript: 'x' })
    expect(parsed.maxShots).toBe(12)
    expect(parsed.transitionMode).toBe('none')
    expect(parsed.confirmBeforeRender).toBe(true)
    expect(ScriptToVideoInputSchema.safeParse({ sceneScript: 'x', maxShots: 0 }).success).toBe(false)
    expect(ScriptToVideoInputSchema.safeParse({ sceneScript: 'x', maxShots: 25 }).success).toBe(false)
    expect(ScriptToVideoInputSchema.safeParse({ sceneScript: 'x', maxShots: 24 }).success).toBe(true)
  })
})
