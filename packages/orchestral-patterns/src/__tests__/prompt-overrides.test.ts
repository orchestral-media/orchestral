import { describe, expect, it } from 'vitest'

import type { ExecutionContext, PatternRef } from '@orchestral/core'

import { createScriptPlanningMeta } from '../meta/script-planning'
import { SCRIPT_PLANNING_DEFAULT_PROMPTS } from '../meta/script-planning'
import {
  SCRIPT_INTENT_ROUTING_PROMPT,
  NARRATIVE_SCRIPT_PLANNING_PROMPT,
  MOTION_SCRIPT_PLANNING_PROMPT,
  MONTAGE_SCRIPT_PLANNING_PROMPT,
} from '../meta/script-planning/prompts'

// Every deliverable meta factory + the smoke deps each one needs. Kept in one
// place so the "construct every meta" case below can't silently miss one.
import { createIdea2VideoMeta } from '../meta/idea2video'
import { createScript2VideoMeta } from '../meta/script2video'
import { createStoryboardMeta } from '../meta/storyboard'
import { createExplainerShortMeta } from '../meta/explainer-short'
import { createEventToScriptMeta } from '../meta/event-to-script'
import { createNovelToEventsMeta } from '../meta/novel-to-events'
import { createProseChunkingMeta } from '../meta/prose-chunking'
import { createLyricsToMvMeta } from '../meta/lyrics-to-mv'
import { createUgcTestimonialMeta } from '../meta/ugc-testimonial'
import { createProductAdShortMeta } from '../meta/product-ad-short'
import { createProductPhotoPackMeta } from '../meta/product-photo-pack'
import { createImageBestOfNMeta } from '../meta/image-best-of-n'
import { createReferenceImageCascadeMeta } from '../meta/reference-image-cascade'

// Fake ExecutionContext mirroring meta-script-planning.test.ts: records each
// ctx.step input in call order and returns canned text-generation outputs.
function makeCtx(stepTexts: readonly string[]) {
  const stepInputs: Array<Record<string, unknown>> = []
  let i = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef): Promise<T> => {
      stepInputs.push(ref.input as Record<string, unknown>)
      return {
        modality: 'text',
        text: stepTexts[i++] ?? '',
        cost: 1,
        latencyMs: 10,
        model: 'test:model',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, stepInputs }
}

// Host-op stubs — never invoked (compose short-circuits before any host op in
// these tests), but satisfy the required `deps` param at construction.
const videoOp = async () => ({ assetId: 'a_stub' })
const handleOp = async () => ({ handle: 'h_stub' })

describe('meta prompt overrides', () => {
  it('threads an override into the sub-step while other prompts stay default', async () => {
    const CUSTOM_ROUTER = 'CUSTOM ROUTER SYSTEM PROMPT'
    const meta = createScriptPlanningMeta({
      prompts: { scriptIntentRouting: CUSTOM_ROUTER },
    })
    // Router text is unparseable → narrative fallback branch (step 2).
    const { ctx, stepInputs } = makeCtx([
      'not json',
      JSON.stringify({ planned_script: 'a plan' }),
    ])

    const out = await meta.compose({ input: { idea: 'a quiet drama' } }, ctx)

    expect(out.intent).toBe('narrative')
    // Step 1 carries the OVERRIDDEN router prompt…
    expect(stepInputs[0].system).toBe(CUSTOM_ROUTER)
    expect(stepInputs[0].system).not.toBe(SCRIPT_INTENT_ROUTING_PROMPT)
    // …while the branch prompt (not overridden) falls back to the default.
    expect(stepInputs[1].system).toBe(NARRATIVE_SCRIPT_PLANNING_PROMPT)
  })

  it('*_DEFAULT_PROMPTS is frozen and equals the ./testing constants', () => {
    expect(Object.isFrozen(SCRIPT_PLANNING_DEFAULT_PROMPTS)).toBe(true)
    expect(SCRIPT_PLANNING_DEFAULT_PROMPTS).toEqual({
      scriptIntentRouting: SCRIPT_INTENT_ROUTING_PROMPT,
      narrativeScriptPlanning: NARRATIVE_SCRIPT_PLANNING_PROMPT,
      motionScriptPlanning: MOTION_SCRIPT_PLANNING_PROMPT,
      montageScriptPlanning: MONTAGE_SCRIPT_PLANNING_PROMPT,
    })
    // Same identity as the constants the ./testing subpath re-exports — the
    // defaults reference the constants, they don't copy the bytes.
    expect(SCRIPT_PLANNING_DEFAULT_PROMPTS.scriptIntentRouting).toBe(
      SCRIPT_INTENT_ROUTING_PROMPT,
    )
    expect(SCRIPT_PLANNING_DEFAULT_PROMPTS.narrativeScriptPlanning).toBe(
      NARRATIVE_SCRIPT_PLANNING_PROMPT,
    )
  })

  it('constructs every meta with no prompt overrides', () => {
    const built = [
      createIdea2VideoMeta({ concatVideos: videoOp }),
      createScript2VideoMeta({ concatVideos: videoOp }),
      createScriptPlanningMeta(),
      createStoryboardMeta(),
      createExplainerShortMeta({ concatVideos: videoOp, stillToVideo: videoOp }),
      createEventToScriptMeta(),
      createNovelToEventsMeta(),
      createProseChunkingMeta(),
      createLyricsToMvMeta({
        concatVideos: videoOp,
        addBackgroundAudio: videoOp,
      }),
      createUgcTestimonialMeta({
        concatVideos: videoOp,
        addBackgroundAudio: videoOp,
        addSubtitles: videoOp,
        createSubtitleAsset: videoOp,
      }),
      createProductAdShortMeta({
        addBackgroundAudio: videoOp,
        recordSessionAsset: handleOp,
      }),
      createProductPhotoPackMeta(),
      createImageBestOfNMeta(),
      createReferenceImageCascadeMeta(),
    ]

    expect(built.map((m) => m.id).sort()).toEqual(
      [
        'meta_event-to-script',
        'meta_explainer-short',
        'meta_idea2video',
        'meta_image-best-of-n',
        'meta_lyrics-to-mv',
        'meta_novel-to-events',
        'meta_product-ad-short',
        'meta_product-photo-pack',
        'meta_prose-chunking',
        'meta_reference-image-cascade',
        'meta_script-planning',
        'meta_script2video',
        'meta_storyboard',
        'meta_ugc-testimonial',
      ].sort(),
    )
  })
})
