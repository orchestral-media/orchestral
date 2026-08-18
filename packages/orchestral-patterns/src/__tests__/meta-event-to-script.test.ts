import { describe, expect, it } from 'vitest'

import type { ExecutionContext, StepOptions, PatternRef } from '@orchestral/core'
import {
  createEventToScriptMeta,
  type Scene,
  type CharacterInEvent,
} from '../meta/event-to-script'
import {
  NEXT_SCENE_EXTRACTION_PROMPT,
  CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT,
  SCRIPT_ENHANCEMENT_PROMPT,
} from '../meta/event-to-script/prompts'

interface RecordedStep {
  patternId: string
  input: Record<string, unknown>
  stepOptions: StepOptions | undefined
}

const sceneSeed = (idx: number, script: string): Scene => ({
  idx,
  environment: { slugline: `INT. SCENE ${idx}`, description: 'a room' },
  characters: [
    {
      idx: 0,
      identifierInScene: 'Alice',
      staticFeatures: 'short hair',
      dynamicFeatures: 'green dress',
      isVisible: true,
    },
  ],
  script,
})

const eventSeed = {
  index: 0,
  description: 'A thief steals a gem',
  timeframe: 'midnight',
  characters: 'thief, guard',
  cause: 'greed',
  process: 'sneaks in, lifts gem, alarm sounds',
  outcome: 'chase begins',
}

/**
 * Fake ExecutionContext that routes by matching the inlined system prompt:
 *   NEXT_SCENE_EXTRACTION_PROMPT          → return scenes array
 *   CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT → return char registry
 *   SCRIPT_ENHANCEMENT_PROMPT             → return enhanced script (one per call)
 *
 * Each polish call returns `enhanced-N` where N is the dispatch index.
 */
function makeCtx(opts: {
  scenes: readonly Scene[]
  charRegistry: readonly CharacterInEvent[]
  polishCosts?: readonly number[]
}) {
  const recorded: RecordedStep[] = []
  let polishCallIdx = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      recorded.push({
        patternId: ref.patternId,
        input,
        stepOptions: options,
      })
      const sys = String(input.system)
      if (sys === NEXT_SCENE_EXTRACTION_PROMPT) {
        return {
          modality: 'text',
          text: JSON.stringify({ scenes: opts.scenes }),
          cost: 5,
          latencyMs: 200,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      if (sys === CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT) {
        return {
          modality: 'text',
          text: JSON.stringify({ characters: opts.charRegistry }),
          cost: 3,
          latencyMs: 100,
          model: 'm',
          provider: 'p',
        } as unknown as T
      }
      // SCRIPT_ENHANCEMENT_PROMPT
      const idx = polishCallIdx
      polishCallIdx++
      return {
        modality: 'text',
        text: JSON.stringify({ enhanced_script: `enhanced-${idx}` }),
        cost: opts.polishCosts?.[idx] ?? 2,
        latencyMs: 80,
        model: 'm',
        provider: 'p',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, recorded }
}

describe('meta_event-to-script', () => {
  it('extracts scenes, merges characters, and polishes per-scene in parallel', async () => {
    const meta = createEventToScriptMeta()
    const charRegistry: CharacterInEvent[] = [
      {
        index: 0,
        identifier_in_event: 'Alice',
        static_features: 'short hair',
        active_scenes: { '0': 'Alice', '1': 'A' },
      },
    ]
    const scenes = [
      sceneSeed(0, 'planned script 0'),
      sceneSeed(1, 'planned script 1'),
    ]
    const { ctx, recorded } = makeCtx({ scenes, charRegistry })

    const out = await meta.compose(
      {
        input: {
          event: eventSeed,
          contextFragments: ['fragment A', 'fragment B'],
        },
      },
      ctx,
    )

    // 1 scene-extraction + 1 char-merge + 2 polish (one per scene) = 4 calls.
    expect(recorded).toHaveLength(4)

    // Scene extraction step carries the real inlined prompt + event description.
    const extractCall = recorded.find(
      (r) => String(r.input.system) === NEXT_SCENE_EXTRACTION_PROMPT,
    )
    expect(extractCall).toBeDefined()
    const extractPrompt = String(extractCall!.input.prompt)
    expect(extractPrompt).toContain('<EVENT_DESCRIPTION_START>')
    expect(extractPrompt).toContain('A thief steals a gem')
    expect(extractPrompt).toContain('Timeframe: midnight')
    expect(extractPrompt).toContain('<CONTEXT_FRAGMENTS_START>')
    expect(extractPrompt).toContain('<FRAGMENT_0_START>')
    expect(extractPrompt).toContain('fragment A')
    expect(extractPrompt).toContain('<FRAGMENT_1_START>')
    expect(extractPrompt).toContain('fragment B')

    // Char-merge step carries the real inlined prompt + SCENE/SCRIPT/CHARACTERS XML.
    const mergeCall = recorded.find(
      (r) => String(r.input.system) === CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT,
    )
    expect(mergeCall).toBeDefined()
    const mergePrompt = String(mergeCall!.input.prompt)
    expect(mergePrompt).toContain('<SCENE_0_START>')
    expect(mergePrompt).toContain('<SCRIPT_START>')
    expect(mergePrompt).toContain('planned script 0')
    expect(mergePrompt).toContain('<CHARACTER_0_START>')
    expect(mergePrompt).toContain('Alice [visible]')
    expect(mergePrompt).toContain('static features: short hair')

    // Polish calls (2) each carry the real enhancement prompt + a unique stepId
    // so parallel dispatches don't collapse onto a single stepCache entry.
    const polishCalls = recorded.filter(
      (r) => String(r.input.system) === SCRIPT_ENHANCEMENT_PROMPT,
    )
    expect(polishCalls).toHaveLength(2)
    const polishStepIds = polishCalls.map((p) => p.stepOptions?.stepId)
    expect(polishStepIds).toEqual(['polish-0', 'polish-1'])
    for (const p of polishCalls) {
      expect(String(p.input.prompt)).toContain('<PLANNED_SCRIPT_START>')
    }

    // Output assembly: each scene gets its polished script grafted on.
    expect(out.eventScenes).toHaveLength(2)
    expect(out.eventScenes[0].polishedScript).toBe('enhanced-0')
    expect(out.eventScenes[1].polishedScript).toBe('enhanced-1')
    expect(out.eventScenes[0].script).toBe('planned script 0') // original preserved
    expect(out.eventScenes[0].characters).toHaveLength(1) // scene chars preserved

    expect(out.eventCharRegistry).toEqual(charRegistry)

    // cost = 5 (extract) + 3 (merge) + 2*2 (polish) = 12.
    // latency = 200 + max(100, max(80,80)) = 300.
    expect(out.cost).toBe(12)
    expect(out.latencyMs).toBe(300)
  })

  it('skips Stage 3 when skipPolish=true and uses scene.script verbatim as polishedScript', async () => {
    const meta = createEventToScriptMeta()
    const scenes = [
      sceneSeed(0, 'raw script 0'),
      sceneSeed(1, 'raw script 1'),
    ]
    const { ctx, recorded } = makeCtx({
      scenes,
      charRegistry: [],
    })

    const out = await meta.compose(
      {
        input: {
          event: eventSeed,
          skipPolish: true,
        },
      },
      ctx,
    )

    // 1 extract + 1 merge, no polish.
    expect(recorded).toHaveLength(2)
    expect(
      recorded.filter((r) => String(r.input.system) === SCRIPT_ENHANCEMENT_PROMPT),
    ).toHaveLength(0)

    // polishedScript === scene.script verbatim when skipped.
    expect(out.eventScenes[0].polishedScript).toBe('raw script 0')
    expect(out.eventScenes[1].polishedScript).toBe('raw script 1')

    // No polish cost or latency contribution.
    // cost = 5 + 3 = 8. latency = 200 + max(100, 0) = 300.
    expect(out.cost).toBe(8)
    expect(out.latencyMs).toBe(300)
  })

  it('keeps cost finite when a polish call reports NaN (sumCosts guard)', async () => {
    const meta = createEventToScriptMeta()
    const scenes = [sceneSeed(0, 's0'), sceneSeed(1, 's1')]
    const { ctx } = makeCtx({
      scenes,
      charRegistry: [],
      polishCosts: [Number.NaN, 2],
    })

    const out = await meta.compose({ input: { event: eventSeed } }, ctx)

    // The NaN polish call is guarded to 0 — extract (5) + merge (3) + the
    // finite polish (2) = 10 instead of a poisoned NaN total.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBe(10)
  })

  it('handles empty contextFragments gracefully (no FRAGMENT_N blocks)', async () => {
    const meta = createEventToScriptMeta()
    const { ctx, recorded } = makeCtx({
      scenes: [sceneSeed(0, 's')],
      charRegistry: [],
    })

    await meta.compose({ input: { event: eventSeed, skipPolish: true } }, ctx)

    const extractCall = recorded[0]!
    const prompt = String(extractCall.input.prompt)
    // Tags present but no fragments.
    expect(prompt).toContain('<CONTEXT_FRAGMENTS_START>')
    expect(prompt).toContain('<CONTEXT_FRAGMENTS_END>')
    expect(prompt).not.toContain('<FRAGMENT_0_START>')
  })

  it('throws when scenes response is malformed JSON — no silent fallback', async () => {
    const meta = createEventToScriptMeta()
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(): Promise<T> =>
        ({
          modality: 'text',
          text: 'not json at all',
          cost: 0,
          latencyMs: 0,
          model: 'm',
          provider: 'p',
        }) as unknown as T,
    } as unknown as ExecutionContext

    await expect(
      meta.compose({ input: { event: eventSeed } }, ctx),
    ).rejects.toThrow()
  })

  it('declares a meta Pattern with stable id, kind, and agent-tool exposure', () => {
    const meta = createEventToScriptMeta()
    expect(meta.id).toBe('meta_event-to-script')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.exposure).toBe('agent-tool')
  })
})
