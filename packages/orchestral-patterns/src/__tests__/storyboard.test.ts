import { describe, expect, it } from 'vitest'

import type {
  ExecutionContext,
  MetaPattern,
  PatternRef,
  StepOptions,
} from '@orchestral/core'
import {
  createStoryboardMeta,
  StoryboardInputSchema,
  type StoryboardInput,
} from '../meta/storyboard'
import { STORYBOARD_DESIGN_PROMPT } from '../meta/_shared/storyboard-design-prompt'
import { createImageBestOfNMeta } from '../meta/image-best-of-n'

interface RecordedStep {
  patternId: string
  input: unknown
  assets: PatternRef['assets']
  stepOptions: StepOptions | undefined
}

/**
 * Fake ExecutionContext. Each call is dispatched by patternId:
 *   • text-generation         → returns `{ text }` = the storyboard-design JSON
 *     ({ storyboard: [ShotBrief] }) — the decomposition step.
 *   • image-to-image          → returns one produced asset
 *     (`asset-i2i-<idx>`).
 *   • meta_image-best-of-n     → returns a best-of-n output with a winning asset.
 *
 * `compute` just runs the fn (parallel() leans on it being awaited, but the
 * meta uses ctx.step + parallel over the panel promises directly).
 */
function makeCtx(
  opts: { designJson?: string; emptyI2iAssets?: boolean; designCost?: number } = {},
) {
  const recorded: RecordedStep[] = []
  let i2iCount = 0
  let bestOfNCount = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      recorded.push({
        patternId: ref.patternId,
        input: ref.input,
        assets: ref.assets,
        stepOptions: options,
      })
      if (ref.patternId === 'text-generation') {
        return {
          modality: 'text',
          text: opts.designJson ?? '{"storyboard":[]}',
          cost: opts.designCost ?? 0.03,
          latencyMs: 10,
          model: 'test:llm',
          provider: 'test',
        } as unknown as T
      }
      if (ref.patternId === 'meta_image-best-of-n') {
        const idx = bestOfNCount++
        return {
          winningAssetId: `asset-bestof-${idx}`,
          reason: 'best',
          allCandidates: [`asset-bestof-${idx}`, `asset-bestof-${idx}-b`],
          cost: 0.5,
          latencyMs: 200,
        } as unknown as T
      }
      // image-to-image
      const idx = i2iCount++
      return {
        modality: 'image',
        assets: opts.emptyI2iAssets
          ? []
          : [{ assetId: `asset-i2i-${idx}`, modality: 'image' }],
        cost: 0.15,
        latencyMs: 100,
        model: 'test:i2i',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, recorded }
}

/**
 * Recursive ExecutionContext that mirrors the runtime's shared-state + stepId
 * namespace contract (ADR-009 §A.5) so we can drive the storyboard meta + its
 * nested meta_image-best-of-n with the REAL compose() bodies and reproduce the
 * "same child meta dispatched twice with fixed explicit stepIds" collision.
 *
 * The runtime threads one `MetaSharedState` (stepIds set + stepCache + default
 * counter) across nested metas, and stamps each child meta with the parent
 * step's effective stepId as a namespace prefix. We re-create exactly that here:
 *   • dispatching meta_image-best-of-n recurses into its compose() with a child
 *     ctx whose namespace = the parent step's effective stepId (panel-N);
 *   • the shared stepIds set throws DUPLICATE_STEP_ID on collision, just like
 *     meta-execution-context.ts:223.
 * Before the namespace fix this set would see candidate-0 twice (one per panel)
 * and throw; after, it sees panel-0/candidate-0 and panel-1/candidate-0.
 *
 * The top-level text-generation (storyboard design) step is scripted by
 * `designJson`; nested image steps return unique assets so a stale cache hit
 * (cross-contamination) is observable.
 */
function makeRecursiveCtx(designJson: string) {
  const recorded: RecordedStep[] = []
  let imageSerial = 0

  const shared = {
    stepIds: new Set<string>(),
    stepCache: new Map<string, unknown>(),
    counter: { value: 0 },
  }

  const registry = new Map<string, MetaPattern>([
    ['meta_image-best-of-n', createImageBestOfNMeta() as MetaPattern],
  ])

  function buildCtx(namespace: string | undefined): ExecutionContext {
    const step = async <T>(
      ref: PatternRef,
      options?: StepOptions,
    ): Promise<T> => {
      const idx = shared.counter.value++
      const stepId = options?.stepId ?? `${ref.patternId}#${idx}`
      const effectiveStepId = namespace ? `${namespace}/${stepId}` : stepId

      if (shared.stepIds.has(effectiveStepId)) {
        throw new Error(
          `DUPLICATE_STEP_ID: reused stepId '${effectiveStepId}'`,
        )
      }
      shared.stepIds.add(effectiveStepId)

      const cached = shared.stepCache.get(effectiveStepId)
      if (cached !== undefined) return cached as T

      recorded.push({
        patternId: ref.patternId,
        input: ref.input,
        assets: ref.assets,
        stepOptions: options,
      })

      let value: unknown
      const nestedMeta = registry.get(ref.patternId)
      if (nestedMeta?.compose) {
        // Recurse with the parent step's effective id as the child namespace —
        // exactly what dispatchMeta does via spec.stepIdNamespace.
        const childCtx = buildCtx(effectiveStepId)
        value = await nestedMeta.compose({ input: ref.input }, childCtx)
      } else if (ref.patternId === 'text-generation') {
        // storyboard-design decomposition.
        value = {
          modality: 'text',
          text: designJson,
          cost: 1,
          latencyMs: 10,
          model: 'test:llm',
          provider: 'test',
        }
      } else if (ref.patternId === 'image-to-text') {
        // best-of-n judge — always pick candidate 0.
        value = {
          modality: 'text',
          text: JSON.stringify({ best_image_index: 0, reason: 'mock' }),
          cost: 1,
          latencyMs: 10,
          model: 'test:vlm',
          provider: 'test',
        }
      } else {
        // text-to-image / image-to-image — unique asset per call so a stale
        // cache hit (cross-contamination) would be observable.
        const id = imageSerial++
        value = {
          modality: 'image',
          assets: [{ assetId: `asset-img-${id}`, modality: 'image' }],
          cost: 1,
          latencyMs: 100,
          model: 'test:i2i',
          provider: 'test',
        }
      }

      shared.stepCache.set(effectiveStepId, value)
      return value as T
    }

    return {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: step as ExecutionContext['step'],
    } as unknown as ExecutionContext
  }

  return { ctx: buildCtx(undefined), recorded }
}

// Two characters with multi-image reference sheets. 仙姬 has two refs to prove
// ALL of a character's handles flow into the panel, not just the first.
const CHARACTERS: StoryboardInput['characters'] = [
  { name: '张院君', refs: ['h-zhang-front', 'h-zhang-side'] },
  { name: '仙姬', refs: ['h-xianji'] },
]

const shot = (
  idx: number,
  visual_desc: string,
  opts: { is_last?: boolean; cam_idx?: number; audio_desc?: string } = {},
) => ({
  idx,
  is_last: opts.is_last ?? false,
  cam_idx: opts.cam_idx ?? 0,
  visual_desc,
  audio_desc: opts.audio_desc ?? '',
})

describe('meta_storyboard', () => {
  it('designs the storyboard via the storyboard-design prompt + json mode, injecting the roster + scene', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [
        shot(0, 'Wide establishing shot. <张院君> stands alone at the gate, facing right.'),
      ],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    await meta.compose(
      {
        input: {
          scene: 'a duel unfolds at the temple gate',
          characters: CHARACTERS,
          userRequirement: 'no more than 6 shots; cinematic realism',
        },
      },
      ctx,
    )

    const textSteps = recorded.filter((r) => r.patternId === 'text-generation')
    expect(textSteps).toHaveLength(1)
    const tg = textSteps[0]!.input as {
      system: string
      prompt: string
      responseFormat: string
      jsonSchema: unknown
    }
    // The decomposition uses the shared storyboard-design prompt (not the old
    // ad-hoc one) + structured-output dispatch.
    expect(tg.system).toBe(STORYBOARD_DESIGN_PROMPT)
    expect(tg.responseFormat).toBe('json')
    expect(tg.jsonSchema).toBeDefined()
    // Scene → <SCRIPT>, roster → <CHARACTERS>, knob → <USER_REQUIREMENT>.
    expect(tg.prompt).toContain('<SCRIPT>')
    expect(tg.prompt).toContain('a duel unfolds at the temple gate')
    expect(tg.prompt).toContain('<CHARACTERS>')
    expect(tg.prompt).toContain('张院君')
    expect(tg.prompt).toContain('仙姬')
    expect(tg.prompt).toContain('<USER_REQUIREMENT>')
    expect(tg.prompt).toContain('no more than 6 shots; cinematic realism')
  })

  it('omits <USER_REQUIREMENT> when no userRequirement is supplied', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [shot(0, '<仙姬> close-up, facing the camera.')],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    await meta.compose(
      { input: { scene: 'a quiet moment', characters: CHARACTERS } },
      ctx,
    )

    const tg = recorded.find((r) => r.patternId === 'text-generation')!.input as {
      prompt: string
    }
    expect(tg.prompt).not.toContain('<USER_REQUIREMENT>')
  })

  it('feeds EVERY on-screen character\'s refs (extracted from visual_desc <Name> tags) into the panel i2i source[] (two characters in one shot keep both)', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [
        shot(0, 'Wide shot. <张院君> stands alone at the gate, facing right.'),
        shot(1, 'Medium two-shot. <张院君> on the left faces <仙姬> on the right.', {
          is_last: true,
          cam_idx: 1,
        }),
      ],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    const out = await meta.compose(
      { input: { scene: 'two rivals meet at the gate', characters: CHARACTERS } },
      ctx,
    )

    const i2iSteps = recorded.filter((r) => r.patternId === 'image-to-image')
    expect(i2iSteps).toHaveLength(2)

    // Panel 0: only 张院君 → both of his refs, none of 仙姬's.
    const p0 = i2iSteps[0]!.input as {
      prompt: string
      references: { source: string[] }
    }
    expect(p0.references.source).toEqual(['h-zhang-front', 'h-zhang-side'])

    // Panel 1: 张院君 + 仙姬 same frame → ALL THREE refs in source[]. This is the
    // exact bug the meta fixes — a hand-rolled i2i would pass only one and lose
    // the other character's identity.
    const p1 = i2iSteps[1]!.input as {
      prompt: string
      references: { source: string[] }
    }
    expect(p1.references.source).toEqual([
      'h-zhang-front',
      'h-zhang-side',
      'h-xianji',
    ])

    // Each panel gets a unique stepId so the stepCache doesn't collapse them.
    expect(i2iSteps[0]!.stepOptions?.stepId).toBe('panel-0')
    expect(i2iSteps[1]!.stepOptions?.stepId).toBe('panel-1')

    // The i2i prompt carries the rich visual_desc as its body…
    expect(p1.prompt).toContain('Medium two-shot')
    // …and spells out which source image is which character (array order), so
    // the model can tell them apart — the load-bearing labelling.
    expect(p1.prompt).toContain('Reference image 1 = 张院君')
    expect(p1.prompt).toContain('Reference image 2 = 张院君')
    expect(p1.prompt).toContain('Reference image 3 = 仙姬')

    // Output: structured panels (carrying the rich shot data) + flat
    // produced-asset list (host renderer reads output.assets[].assetId).
    expect(out.panels.map((p) => p.shotIndex)).toEqual([0, 1])
    expect(out.panels[1]!.characterNames).toEqual(['张院君', '仙姬'])
    expect(out.panels[1]!.camIdx).toBe(1)
    expect(out.panels[1]!.visualDesc).toContain('Medium two-shot')
    expect(out.assets).toEqual([
      { assetId: 'asset-i2i-0', modality: 'image' },
      { assetId: 'asset-i2i-1', modality: 'image' },
    ])

    // Aggregated cost = design text-generation (0.03) + each i2i panel (0.15 ×2).
    expect(out.cost).toBeCloseTo(0.03 + 0.15 + 0.15)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps cost finite when the design step reports NaN (sumCosts guard)', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [shot(0, '<仙姬> close-up, facing the camera.', { is_last: true })],
    })
    const { ctx } = makeCtx({ designJson, designCost: Number.NaN })

    const out = await meta.compose(
      { input: { scene: 'a quiet moment', characters: CHARACTERS } },
      ctx,
    )

    // The NaN design cost is guarded to 0 — only the single i2i panel (0.15)
    // counts instead of poisoning the whole aggregate.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBeCloseTo(0.15)
  })

  it('keeps the same character\'s ref handle consistent across every panel it appears in', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [
        shot(0, '<仙姬> beat 1'),
        shot(1, '<仙姬> beat 2'),
        shot(2, '<仙姬> beat 3', { is_last: true }),
      ],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    await meta.compose(
      { input: { scene: 'three beats with 仙姬', characters: CHARACTERS } },
      ctx,
    )

    const sources = recorded
      .filter((r) => r.patternId === 'image-to-image')
      .map(
        (r) => (r.input as { references: { source: string[] } }).references.source,
      )
    // Same handle in every panel — no drift.
    expect(sources).toEqual([['h-xianji'], ['h-xianji'], ['h-xianji']])
  })

  it('de-duplicates a character tagged more than once in one shot\'s visual_desc', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [
        shot(
          0,
          'Over-the-shoulder. <张院君> in the foreground, then a reverse on <张院君> again.',
          { is_last: true },
        ),
      ],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    const out = await meta.compose(
      { input: { scene: 's', characters: CHARACTERS } },
      ctx,
    )

    // 张院君 tagged twice → one character, his refs added once (not doubled).
    const i2i = recorded.find((r) => r.patternId === 'image-to-image')!.input as {
      references: { source: string[] }
    }
    expect(i2i.references.source).toEqual(['h-zhang-front', 'h-zhang-side'])
    expect(out.panels[0]!.characterNames).toEqual(['张院君'])
  })

  it('routes each panel through meta_image-best-of-n with the correct n when bestOfN is set', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [shot(0, '<张院君> portrait, facing forward.', { is_last: true })],
    })
    const { ctx, recorded } = makeCtx({ designJson })

    const out = await meta.compose(
      {
        input: { scene: 'quality matters', characters: CHARACTERS, bestOfN: 3 },
      },
      ctx,
    )

    const bestOf = recorded.filter((r) => r.patternId === 'meta_image-best-of-n')
    expect(bestOf).toHaveLength(1)
    const input = bestOf[0]!.input as {
      innerPatternId: string
      n: number
      innerInput: { references: { source: string[] } }
      referenceHandles: string[]
      refDescriptions: string[]
    }
    expect(input.innerPatternId).toBe('image-to-image')
    expect(input.n).toBe(3)
    // The fused source[] is forwarded to the inner i2i, unchanged.
    expect(input.innerInput.references.source).toEqual([
      'h-zhang-front',
      'h-zhang-side',
    ])
    // The same refs are also handed to the judge as ground truth so it scores
    // candidates on character consistency, not description-fidelity alone.
    expect(input.referenceHandles).toEqual(['h-zhang-front', 'h-zhang-side'])
    // Each handle is captioned (by index) with the character it depicts.
    expect(input.refDescriptions).toEqual(['张院君 reference', '张院君 reference'])
    // No bare image-to-image dispatch on the bestOfN path.
    expect(recorded.some((r) => r.patternId === 'image-to-image')).toBe(false)

    // Winner asset id flows into the panel + the flat asset list.
    expect(out.panels[0]!.assetIds).toEqual(['asset-bestof-0'])
    expect(out.assets).toEqual([{ assetId: 'asset-bestof-0', modality: 'image' }])

    // Aggregated cost = design text-generation (0.03) + the single best-of-n
    // panel's cost (0.5); the bare i2i cost is NOT counted on this path.
    expect(out.cost).toBeCloseTo(0.03 + 0.5)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('renders ≥2 panels with bestOfN without DUPLICATE_STEP_ID — each panel dispatches its own best-of-n (ADR-009 §A.5 namespace)', async () => {
    // Acceptance point for the nested-meta stepId namespace fix. The storyboard
    // dispatches meta_image-best-of-n once per panel (panel-0, panel-1); the
    // best-of-n meta internally uses FIXED explicit stepIds (candidate-0,
    // candidate-1). Sharing one stepIds set across panels, candidate-0 would
    // collide on panel-1 → DUPLICATE_STEP_ID. The namespace prefix makes them
    // panel-0/candidate-0 vs panel-1/candidate-0, so this composes cleanly.
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [
        shot(0, '<张院君> portrait'),
        shot(1, '<仙姬> portrait', { is_last: true }),
      ],
    })
    const { ctx, recorded } = makeRecursiveCtx(designJson)

    const out = await meta.compose(
      {
        input: {
          scene: 'two beats, quality-gated',
          characters: CHARACTERS,
          bestOfN: 2,
        },
      },
      ctx,
    )

    // One best-of-n dispatch per panel, each with its own panel-N stepId.
    const bestOf = recorded.filter((r) => r.patternId === 'meta_image-best-of-n')
    expect(bestOf).toHaveLength(2)
    expect(bestOf[0]!.stepOptions?.stepId).toBe('panel-0')
    expect(bestOf[1]!.stepOptions?.stepId).toBe('panel-1')

    // 2 panels × 2 candidates = 4 inner i2i renders — proves the shared
    // stepCache didn't collapse panel-1's candidates onto panel-0's.
    const i2i = recorded.filter((r) => r.patternId === 'image-to-image')
    expect(i2i).toHaveLength(4)

    // Each panel resolves to its OWN winning candidate (candidate-0 of its own
    // namespace), and the two winners are distinct produced assets.
    expect(out.panels.map((p) => p.shotIndex)).toEqual([0, 1])
    const winners = out.panels.flatMap((p) => p.assetIds)
    expect(winners).toHaveLength(2)
    expect(new Set(winners).size).toBe(2)
  })

  it('fails closed when a shot tags a character not in the registry', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [shot(0, 'who is this? <幽灵> appears.', { is_last: true })],
    })
    const { ctx } = makeCtx({ designJson })

    await expect(
      meta.compose(
        { input: { scene: 'mystery guest', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_UNKNOWN_CHARACTER.*幽灵/)
  })

  it('fails closed (STORYBOARD_NO_SOURCE) when a shot tags no character at all', async () => {
    const meta = createStoryboardMeta()
    // A visual_desc with no <Name> tag → no on-screen character → nothing to
    // render from. We do NOT silently degrade to text-to-image.
    const designJson = JSON.stringify({
      storyboard: [shot(0, 'An empty hall, wide and still.', { is_last: true })],
    })
    const { ctx } = makeCtx({ designJson })

    await expect(
      meta.compose(
        { input: { scene: 'empty room', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_NO_SOURCE: panel 0/)
  })

  it('rejects an empty input scene at the schema boundary', () => {
    const result = StoryboardInputSchema.safeParse({
      scene: '',
      characters: CHARACTERS,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /scene required/.test(i.message)),
      ).toBe(true)
    }
  })

  it('rejects an empty character registry at the schema boundary', () => {
    const result = StoryboardInputSchema.safeParse({
      scene: 'a scene',
      characters: [],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          /at least one character/.test(i.message),
        ),
      ).toBe(true)
    }
  })

  it('throws a tagged STORYBOARD_DECOMPOSE_FAILED when storyboard design returns non-JSON', async () => {
    const meta = createStoryboardMeta()
    const { ctx } = makeCtx({ designJson: 'not json at all {{{' })

    await expect(
      meta.compose(
        { input: { scene: 'a duel unfolds', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_DECOMPOSE_FAILED/)
  })

  it('throws a tagged STORYBOARD_DECOMPOSE_FAILED when design returns the wrong shape', async () => {
    const meta = createStoryboardMeta()
    // Valid JSON, wrong shape (storyboard is not an array) → ZodError, retagged.
    const { ctx } = makeCtx({ designJson: '{"storyboard":"nope"}' })

    await expect(
      meta.compose(
        { input: { scene: 'a duel unfolds', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_DECOMPOSE_FAILED/)
  })

  it('throws a tagged STORYBOARD_DECOMPOSE_FAILED when design returns an empty storyboard', async () => {
    const meta = createStoryboardMeta()
    // .min(1) on the storyboard array → ZodError, retagged. No silent empty run.
    const { ctx } = makeCtx({ designJson: '{"storyboard":[]}' })

    await expect(
      meta.compose(
        { input: { scene: 'nothing happens', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_DECOMPOSE_FAILED/)
  })

  it('throws STORYBOARD_EMPTY_PANEL when single i2i render returns no asset (symmetric with best-of-n)', async () => {
    const meta = createStoryboardMeta()
    const designJson = JSON.stringify({
      storyboard: [shot(0, '<张院君> portrait', { is_last: true })],
    })
    const { ctx } = makeCtx({ designJson, emptyI2iAssets: true })

    await expect(
      meta.compose(
        { input: { scene: 'one beat', characters: CHARACTERS } },
        ctx,
      ),
    ).rejects.toThrow(/STORYBOARD_EMPTY_PANEL: panel 0/)
  })

  it('falls back to XML decode when the json path fails, preserving <Name> tags', async () => {
    const meta = createStoryboardMeta()
    const xml = `<storyboard>
      <shot><idx>0</idx><is_last>true</is_last><cam_idx>0</cam_idx>
        <visual_desc>Wide shot. <张院君> at the gate, facing right.</visual_desc>
        <audio_desc>[SFX] wind</audio_desc></shot>
    </storyboard>`

    const recorded: { responseFormat?: string; stepId?: string }[] = []
    let i2i = 0
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(
        ref: { patternId: string; input: unknown },
        options?: { stepId?: string },
      ): Promise<T> => {
        if (ref.patternId === 'text-generation') {
          const fmt = (ref.input as { responseFormat?: string }).responseFormat
          recorded.push({ responseFormat: fmt, stepId: options?.stepId })
          if (fmt === 'json')
            throw new Error(
              'STRUCTURED_OUTPUT_MISSING: model returned no schema-shaped output',
            )
          return {
            modality: 'text',
            text: xml,
            cost: 0.03,
            latencyMs: 10,
            model: 'm',
            provider: 'p',
          } as unknown as T
        }
        return {
          modality: 'image',
          assets: [{ assetId: `asset-i2i-${i2i++}`, modality: 'image' }],
          cost: 0.15,
          latencyMs: 100,
          model: 'm',
          provider: 'p',
        } as unknown as T
      },
    } as unknown as ExecutionContext

    const out = await meta.compose(
      { input: { scene: 'a duel at the gate', characters: CHARACTERS } },
      ctx,
    )

    expect(recorded.map((r) => r.responseFormat)).toEqual(['json', 'text'])
    expect(recorded.map((r) => r.stepId)).toEqual([
      'decompose-json',
      'decompose-xml',
    ])
    expect(out.panels[0]!.characterNames).toEqual(['张院君'])
    expect(out.assets).toEqual([{ assetId: 'asset-i2i-0', modality: 'image' }])

    // Cost aggregates the FALLBACK (XML) gen's cost (0.03) — the json attempt
    // threw and produced no output — plus the single i2i panel (0.15).
    expect(out.cost).toBeCloseTo(0.03 + 0.15)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('throws STORYBOARD_DECOMPOSE_FAILED when BOTH json and XML fail', async () => {
    const meta = createStoryboardMeta()
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(ref: {
        patternId: string
        input: unknown
      }): Promise<T> => {
        if (ref.patternId === 'text-generation') {
          const fmt = (ref.input as { responseFormat?: string }).responseFormat
          if (fmt === 'json') throw new Error('STRUCTURED_OUTPUT_MISSING')
          return {
            modality: 'text',
            text: 'no xml here either',
            cost: 1,
            latencyMs: 1,
            model: 'm',
            provider: 'p',
          } as unknown as T
        }
        return {} as unknown as T
      },
    } as unknown as ExecutionContext

    await expect(
      meta.compose({ input: { scene: 's', characters: CHARACTERS } }, ctx),
    ).rejects.toThrow(/STORYBOARD_DECOMPOSE_FAILED/)
  })

  it('declares a meta Pattern with stable id, kind, and discovery tokens', () => {
    const meta = createStoryboardMeta()
    expect(meta.id).toBe('meta_storyboard')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    // Default exposure (chat + agent visible) — no explicit exposure field.
    expect(meta.exposure).toBeUndefined()
    // Discovery tokens live where the index reads them: searchHint + tool.description.
    expect(meta.searchHint).toContain('storyboard')
    expect(meta.searchHint).toContain('shot sequence')
    expect(meta.searchHint).toContain('consistent across panels')
    expect(meta.tool.description.toLowerCase()).toContain('storyboard')
    expect(meta.tool.description).toContain('consistent')
  })
})
