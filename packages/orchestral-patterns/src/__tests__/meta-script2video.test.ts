import { describe, expect, it, vi } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'
import {
  createScript2VideoMeta,
  type ScriptToVideoMetaDeps,
} from '../meta/script2video'
import {
  CHARACTER_EXTRACTION_PROMPT,
  PORTRAIT_FRONT_PROMPT,
  STORYBOARD_DESIGN_PROMPT,
  SHOT_VISUAL_DECOMPOSITION_PROMPT,
  CAMERA_TREE_CONSTRUCTION_PROMPT,
  CINEMATIC_SHOT_FRAMING_PROMPT,
  I2V_SHOT_SINGLE_PROMPT,
  I2V_SHOT_TRANSITION_PROMPT,
} from '../meta/script2video/prompts'

// Image-gen + i2v atomics have no `system` slot, so the meta folds the inlined
// SKILL prompt const into the `prompt` field as a PREFIX. Routing/identification
// in these tests therefore matches the prompt prefix against the real prompt
// constants (post-split the old `SKILL::<slug>` markers no longer exist).
const promptStartsWith = (input: Record<string, unknown>, prefix: string) =>
  String((input as { prompt?: string }).prompt ?? '').startsWith(prefix)

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

// Post-split routing: the meta bakes the real inlined prompt bodies into the
// text-generation `system` field (no SkillLoader). The fake ctx therefore
// routes text-generation by matching `system` against the exported prompt
// constants instead of the old `system.includes('<slug>')` markers. The
// per-step `prompt` strings (built by the source's prompt helpers — unchanged
// by the split) still carry the literal markers the assertions check
// ('portrait-front', 'first frame', 'i2v-shot-single', etc.).

// Recorded shape per ctx.step call. `assets` carries the internal-asset
// channel (ref.assets) — source/reference/startFrame now flow there by
// assetId, not through input.references.
interface Call {
  patternId: string
  input: Record<string, unknown>
  assets: PatternRef['assets']
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

// Routing mock: returns the right shape per dispatched capability.
function makeCtx() {
  const calls: Array<Call> = []
  let asset = 0
  const text = (obj: unknown) => ({
    modality: 'text' as const,
    text: JSON.stringify(obj),
    cost: COST_BY_PATTERN['text-generation']!,
    latencyMs: 5,
    model: 'm',
    provider: 'p',
  })
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      calls.push({ patternId: ref.patternId, input, assets: ref.assets })
      if (ref.patternId === 'text-generation') {
        const sys = String(input.system)
        if (sys === STORYBOARD_DESIGN_PROMPT) {
          return text({
            storyboard: [
              { idx: 0, is_last: false, cam_idx: 0, visual_desc: 'shot A', audio_desc: '' },
              { idx: 1, is_last: true, cam_idx: 0, visual_desc: 'shot B', audio_desc: '' },
            ],
          }) as unknown as T
        }
        if (sys === SHOT_VISUAL_DECOMPOSITION_PROMPT) {
          return text({
            ff_desc: 'first frame',
            ff_vis_char_idxs: [0],
            lf_desc: 'last frame',
            lf_vis_char_idxs: [0],
            motion_desc: 'pan left',
            variation_type: 'small',
            variation_reason: 'minor',
          }) as unknown as T
        }
        if (sys === CAMERA_TREE_CONSTRUCTION_PROMPT) {
          return text({ camera_parent_items: [null] }) as unknown as T
        }
        return text({ characters: [] }) as unknown as T
      }
      if (ref.patternId === 'text-to-image') {
        asset += 1
        return {
          modality: 'image',
          assets: [{ handle: `img-h${asset}`, assetId: `img-id${asset}`, modality: 'image' }],
          cost: COST_BY_PATTERN['text-to-image']!,
          latencyMs: 5,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      if (ref.patternId === 'image-to-image') {
        asset += 1
        return {
          modality: 'image',
          assets: [{ handle: `i2i-h${asset}`, assetId: `i2i-id${asset}`, modality: 'image' }],
          cost: COST_BY_PATTERN['image-to-image']!,
          latencyMs: 5,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      // image-to-video
      asset += 1
      return {
        modality: 'video',
        assets: [{ handle: `vid-h${asset}`, assetId: `vid-id${asset}`, modality: 'video' }],
        cost: COST_BY_PATTERN['image-to-video']!,
        latencyMs: 5,
        model: 'm',
        provider: 'p',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, calls }
}

describe("meta_script2video (W-1')", () => {
  it('runs the 8-stage DAG and concatenates the per-shot clips', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      {
        input: {
          // pre-supply one visible character so stage 1 is skipped.
          sceneScript: 'a short scene',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
        },
      },
      ctx,
    )

    // 2 shots → 2 frames, 2 clips. 1 visible character → 3 portraits (front
    // t2i + side i2i + back i2i). Concatenated in order.
    expect(out.shotCount).toBe(2)
    expect(concatVideos).toHaveBeenCalledTimes(1)
    const concatArg = concatVideos.mock.calls[0][0]
    expect(concatArg).toHaveLength(2)
    expect(out.videoAssetId).toBe(`final[${concatArg.join(',')}]`)

    // Meta envelope — accumulated cost is the sum over every paid atomic
    // dispatch (host concatVideos runs via ctx.compute and adds nothing);
    // latency is a non-negative wall-clock delta.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // Stage 1 skipped (characters provided) → no character-extraction text step.
    const charSteps = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === CHARACTER_EXTRACTION_PROMPT,
    )
    expect(charSteps).toHaveLength(0)

    // Stage 2 — 3 portrait calls per visible character: 1 t2i (front, prompt
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
    // the t2i model can pick the matching angle — now by assetId via ref.assets,
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
    // 'startFrame' via ref.assets), prompt prefixed with I2V_SHOT_SINGLE_PROMPT
    // (the C12 single-shot split).
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

  it('feeds userRequirement to the storyboard step under <USER_REQUIREMENT> (the tag the prompt reads)', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()
    await meta.compose(
      {
        input: {
          sceneScript: 'a short scene',
          userRequirement: 'no more than 4 shots',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
        },
      },
      ctx,
    )
    const storyboardCall = calls.find(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === STORYBOARD_DESIGN_PROMPT,
    )
    const prompt = String(storyboardCall!.input.prompt)
    // storyboard-design SKILL.md reads <USER_REQUIREMENT>; the old <REQUIREMENT>
    // tag was never matched so the requirement was silently dropped.
    expect(prompt).toContain('<USER_REQUIREMENT>\nno more than 4 shots\n</USER_REQUIREMENT>')
    expect(prompt).not.toContain('<REQUIREMENT>')
  })

  // Stage 5 camera-tree-construction is dispatched and its output drives
  // Stage 6: child shots route through image-to-image primary with their
  // parent's first frame as `references.source` instead of text-to-image with
  // the portrait registry.
  it('routes child shots through image-to-image with parent frame as source', async () => {
    const calls: Array<Call> = []
    let asset = 0
    const text = (obj: unknown) => ({
      modality: 'text' as const,
      text: JSON.stringify(obj),
      cost: COST_BY_PATTERN['text-generation']!,
      latencyMs: 5,
      model: 'm',
      provider: 'p',
    })
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(ref: PatternRef): Promise<T> => {
        const input = ref.input as Record<string, unknown>
        calls.push({ patternId: ref.patternId, input, assets: ref.assets })
        if (ref.patternId === 'text-generation') {
          const sys = String(input.system)
          if (sys === STORYBOARD_DESIGN_PROMPT) {
            // 3 shots: cam 0 (root) → cam 1 (child of cam 0) → cam 0 again
            return text({
              storyboard: [
                { idx: 0, is_last: false, cam_idx: 0, visual_desc: 'wide street, Alice walking', audio_desc: '' },
                { idx: 1, is_last: false, cam_idx: 1, visual_desc: "close-up Alice's face", audio_desc: '' },
                { idx: 2, is_last: true, cam_idx: 0, visual_desc: 'wide street, Alice approaches Bob', audio_desc: '' },
              ],
            }) as unknown as T
          }
          if (sys === SHOT_VISUAL_DECOMPOSITION_PROMPT) {
            return text({
              ff_desc: 'frame description',
              ff_vis_char_idxs: [0],
              lf_desc: 'last frame',
              lf_vis_char_idxs: [0],
              motion_desc: 'pan left',
              variation_type: 'small',
              variation_reason: 'minor',
            }) as unknown as T
          }
          if (sys === CAMERA_TREE_CONSTRUCTION_PROMPT) {
            // cam 0 (root, free-standing entry as null); cam 1's parent is cam 0, shot 0.
            return text({
              camera_parent_items: [
                null,
                {
                  parent_cam_idx: 0,
                  parent_shot_idx: 0,
                  reason: 'medium covers close-up',
                  is_parent_fully_covers_child: false,
                  missing_info: "frontal view of Alice's face",
                },
              ],
            }) as unknown as T
          }
          return text({ characters: [] }) as unknown as T
        }
        if (ref.patternId === 'text-to-image') {
          asset += 1
          return {
            modality: 'image',
            assets: [{ handle: `img-h${asset}`, assetId: `img-id${asset}`, modality: 'image' }],
            cost: COST_BY_PATTERN['text-to-image']!, latencyMs: 5, model: 'm', provider: 'p',
          } as unknown as T
        }
        if (ref.patternId === 'image-to-image') {
          asset += 1
          return {
            modality: 'image',
            assets: [{ handle: `i2i-h${asset}`, assetId: `i2i-id${asset}`, modality: 'image' }],
            cost: COST_BY_PATTERN['image-to-image']!, latencyMs: 5, model: 'm', provider: 'p',
          } as unknown as T
        }
        asset += 1
        return {
          modality: 'video',
          assets: [{ handle: `vid-h${asset}`, assetId: `vid-id${asset}`, modality: 'video' }],
          cost: COST_BY_PATTERN['image-to-video']!, latencyMs: 5, model: 'm', provider: 'p',
        } as unknown as T
      },
    } as unknown as ExecutionContext

    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })

    const out = await meta.compose(
      {
        input: {
          sceneScript: 'a scene with close-up cut',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
        },
      },
      ctx,
    )

    expect(out.shotCount).toBe(3)

    // Meta envelope — cost sums every paid atomic dispatch (incl. the child
    // shot's image-to-image frame), latency is non-negative.
    const expected = expectedCost(calls)
    expect(expected).toBeGreaterThan(0)
    expect(out.cost).toBeCloseTo(expected)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // Stage 5 — camera-tree-construction was dispatched.
    const cameraTreeCalls = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === CAMERA_TREE_CONSTRUCTION_PROMPT,
    )
    expect(cameraTreeCalls).toHaveLength(1)
    // Camera-tree prompt uses the SKILL.md-mandated <CAMERA_SEQ> shape.
    const ctPrompt = String(cameraTreeCalls[0]!.input.prompt)
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
    expect(String(childCall.input.prompt)).toContain('[Camera-tree hint]')
    expect(String(childCall.input.prompt)).toContain('frontal view')

    // Stage 7 — 3 video clips, each animating from a frame handle.
    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(3)
  })

  // transitionMode: 'between-shots' inserts N-1 transition clips between
  // adjacent shots and interleaves them into concat order.
  it('renders N-1 transition clips and interleaves when transitionMode=between-shots', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      {
        input: {
          sceneScript: 'two shots',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
          transitionMode: 'between-shots',
        },
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

    // Transition prompt carries both shots' visual descriptions verbatim from
    // the storyboard ("shot A" and "shot B" per makeCtx scripted output).
    const tPrompt = String(
      (transitionCalls[0]!.input as { prompt: string }).prompt,
    )
    expect(tPrompt).toContain('The first shot description: shot A')
    expect(tPrompt).toContain('The second shot description: shot B')
    expect(tPrompt).toContain('cut to')

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
    const calls: Array<Call> = []
    let asset = 0
    const text = (obj: unknown) => ({
      modality: 'text' as const,
      text: JSON.stringify(obj),
      cost: COST_BY_PATTERN['text-generation']!,
      latencyMs: 5,
      model: 'm',
      provider: 'p',
    })
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(ref: PatternRef): Promise<T> => {
        const input = ref.input as Record<string, unknown>
        calls.push({ patternId: ref.patternId, input, assets: ref.assets })
        if (ref.patternId === 'text-generation') {
          const sys = String(input.system)
          if (sys === STORYBOARD_DESIGN_PROMPT) {
            return text({
              storyboard: [
                { idx: 0, is_last: true, cam_idx: 0, visual_desc: 'lone shot', audio_desc: '' },
              ],
            }) as unknown as T
          }
          if (sys === SHOT_VISUAL_DECOMPOSITION_PROMPT) {
            return text({
              ff_desc: 'first frame',
              ff_vis_char_idxs: [0],
              lf_desc: 'last frame',
              lf_vis_char_idxs: [0],
              motion_desc: 'pan left',
              variation_type: 'small',
              variation_reason: 'minor',
            }) as unknown as T
          }
          if (sys === CAMERA_TREE_CONSTRUCTION_PROMPT) {
            return text({ camera_parent_items: [null] }) as unknown as T
          }
          return text({ characters: [] }) as unknown as T
        }
        if (ref.patternId === 'text-to-image') {
          asset += 1
          return {
            modality: 'image',
            assets: [{ handle: `img-h${asset}`, assetId: `img-id${asset}`, modality: 'image' }],
            cost: COST_BY_PATTERN['text-to-image']!, latencyMs: 5, model: 'm', provider: 'p',
          } as unknown as T
        }
        if (ref.patternId === 'image-to-image') {
          asset += 1
          return {
            modality: 'image',
            assets: [{ handle: `i2i-h${asset}`, assetId: `i2i-id${asset}`, modality: 'image' }],
            cost: COST_BY_PATTERN['image-to-image']!, latencyMs: 5, model: 'm', provider: 'p',
          } as unknown as T
        }
        asset += 1
        return {
          modality: 'video',
          assets: [{ handle: `vid-h${asset}`, assetId: `vid-id${asset}`, modality: 'video' }],
          cost: COST_BY_PATTERN['image-to-video']!, latencyMs: 5, model: 'm', provider: 'p',
        } as unknown as T
      },
    } as unknown as ExecutionContext

    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })

    await meta.compose(
      {
        input: {
          sceneScript: 'single shot scene',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
          transitionMode: 'between-shots',
        },
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

  it('keeps the single-shot path when transitionMode is omitted (backward compat)', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    await meta.compose(
      {
        input: {
          sceneScript: 'two shots, no transitions',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
          ],
        },
      },
      ctx,
    )

    const videoCalls = calls.filter((c) => c.patternId === 'image-to-video')
    expect(videoCalls).toHaveLength(2) // 2 single shots, 0 transitions
    const transitionCalls = videoCalls.filter((c) =>
      String((c.input as { prompt: string }).prompt).includes('i2v-shot-transition'),
    )
    expect(transitionCalls).toHaveLength(0)
    expect(concatVideos.mock.calls[0][0]).toHaveLength(2)
  })

  it('emits the input tags shot-visual-decomposition declares, with the indexed character list', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    await meta.compose(
      {
        input: {
          sceneScript: 'a short scene',
          characters: [
            {
              idx: 0,
              identifierInScene: 'Alice',
              staticFeatures: 'short hair',
              dynamicFeatures: 'green dress',
              isVisible: true,
            },
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
        },
      },
      ctx,
    )

    const decomposeCalls = calls.filter(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === SHOT_VISUAL_DECOMPOSITION_PROMPT,
    )
    expect(decomposeCalls).toHaveLength(2) // one per storyboard shot

    // The SKILL body declares <VISUAL_DESC> + <CHARACTERS>; the dispatched
    // user prompt must emit exactly those (it used to send <SHOT> and drop the
    // character list entirely, which desynced ff_vis_char_idxs from the
    // portrait registry).
    const tags = declaredTags(SHOT_VISUAL_DECOMPOSITION_PROMPT)
    expect(tags.sort()).toEqual(['CHARACTERS', 'VISUAL_DESC'])
    for (const call of decomposeCalls) {
      const prompt = String(call.input.prompt)
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
    expect(String(decomposeCalls[0]!.input.prompt)).toContain(
      '<VISUAL_DESC>\nshot A\n</VISUAL_DESC>',
    )
    expect(String(decomposeCalls[1]!.input.prompt)).toContain(
      '<VISUAL_DESC>\nshot B\n</VISUAL_DESC>',
    )
  })

  it('extracts characters via text-generation when none are supplied', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createScript2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      { input: { sceneScript: 'A hero walks into a field.' } },
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
      meta.compose({ input: { sceneScript: 'A hero walks into a field.' } }, ctx),
    ).rejects.toThrow('script2video: characters: text-generation did not return valid JSON')

    // The failed parse short-circuits before any paid image/video dispatch.
    expect(calls.filter((c) => c.patternId !== 'text-generation')).toHaveLength(0)
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
})
