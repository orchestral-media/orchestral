import { describe, expect, it, vi } from 'vitest'

import type { ExecutionContext, PatternRef, AskUserGeneric } from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import { createIdea2VideoMeta } from '../meta/idea2video'
import {
  STORY_DEVELOPMENT_PROMPT,
  CHARACTER_EXTRACTION_PROMPT,
} from '../meta/idea2video/prompts'

// Routing mock: text-generation routed by the inlined system prompt const; the
// nested meta_script2video is mocked to return a per-scene video asset.
function makeCtx(
  opts: {
    // The resumed answer for the script-approval checkpoint (FormEdit values).
    // Omitted = approve unchanged (the fake returns the payload's field values).
    approval?: { values: Record<string, string> }
    // Raw text returned by the character-extraction step (default: one valid character).
    charactersText?: string
    // Raw text returned by the script-writing step (default: three scene scripts).
    scriptText?: string
  } = {},
) {
  const calls: Array<{ patternId: string; input: Record<string, unknown> }> = []
  const askUserCalls: Array<{ kind: string; payload: unknown }> = []
  let scene = 0
  const text = (obj: unknown) => ({
    modality: 'text' as const,
    text: typeof obj === 'string' ? obj : JSON.stringify(obj),
    cost: 0.01,
    latencyMs: 5,
    model: 'm',
    provider: 'p',
  })
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    // idea2video calls ctx.askUser.form(...); wrap the recording raw bridge in
    // the real facade so the test exercises the actual confirm/choose/form path.
    askUser: buildAskUserFacade(
      (async (o: {
        kind: string
        payload: { fields: { key: string; value: string }[] }
      }) => {
        askUserCalls.push({ kind: o.kind, payload: o.payload })
        // Default = approve unchanged: echo the payload's field values back.
        return (
          opts.approval ?? {
            values: Object.fromEntries(o.payload.fields.map((f) => [f.key, f.value])),
          }
        )
      }) as unknown as AskUserGeneric,
    ),
    step: async <T>(ref: PatternRef): Promise<T> => {
      const input = ref.input as Record<string, unknown>
      calls.push({ patternId: ref.patternId, input })
      if (ref.patternId === 'meta_script2video') {
        scene += 1
        return { videoAssetId: `scene-vid-${scene}`, shotCount: 1, cost: 0.5 } as unknown as T
      }
      const sys = String(input.system)
      if (sys === STORY_DEVELOPMENT_PROMPT) {
        return text('Once upon a time, a full story document.') as unknown as T
      }
      if (sys === CHARACTER_EXTRACTION_PROMPT) {
        return text(
          opts.charactersText ?? {
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
        ) as unknown as T
      }
      // SCRIPT_WRITING_PROMPT
      return text(
        opts.scriptText ?? { script: ['scene one script', 'scene two script', 'scene three script'] },
      ) as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, calls, askUserCalls }
}

describe("meta_idea2video (W-1')", () => {
  it('develops story → characters → scripts, renders each scene, concatenates', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createIdea2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()

    const out = await meta.compose(
      { input: { idea: 'a robot learns to paint', style: 'pixar' } },
      ctx,
    )

    // 3 scenes → 3 nested script2video dispatches.
    const sceneCalls = calls.filter((c) => c.patternId === 'meta_script2video')
    expect(sceneCalls).toHaveLength(3)
    expect(out.sceneCount).toBe(3)

    // The extracted characters are threaded into every scene for consistency.
    for (const s of sceneCalls) {
      expect((s.input.characters as unknown[])).toHaveLength(1)
      expect(s.input.style).toBe('pixar')
    }

    // Story step is free-form text (no jsonSchema).
    const storyCall = calls.find(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === STORY_DEVELOPMENT_PROMPT,
    )
    expect(storyCall?.input.jsonSchema).toBeUndefined()
    expect(storyCall?.input.responseFormat).toBeUndefined()

    // Final video concatenates the three scene videos in order.
    expect(concatVideos).toHaveBeenCalledWith([
      'scene-vid-1',
      'scene-vid-2',
      'scene-vid-3',
    ])
    expect(out.videoAssetId).toBe('final[scene-vid-1,scene-vid-2,scene-vid-3]')

    // Cost rolls up the 3 text-generation calls (0.01 each) + every nested
    // script2video scene output (0.5 each). concatVideos adds no model cost.
    expect(out.cost).toBeCloseTo(0.01 * 3 + 0.5 * 3)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('feeds userRequirement under <USER_REQUIREMENT> (the tag the story/script prompts read)', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createIdea2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx()
    await meta.compose(
      { input: { idea: 'a robot learns to paint', userRequirement: 'keep it under 60s' } },
      ctx,
    )
    const storyCall = calls.find(
      (c) =>
        c.patternId === 'text-generation' &&
        String(c.input.system) === STORY_DEVELOPMENT_PROMPT,
    )
    const prompt = String(storyCall!.input.prompt)
    // The prompts read <USER_REQUIREMENT>; the old <REQUIREMENT> tag was never
    // matched so the requirement was silently dropped.
    expect(prompt).toContain('<USER_REQUIREMENT>\nkeep it under 60s\n</USER_REQUIREMENT>')
    expect(prompt).not.toContain('<REQUIREMENT>')
  })

  it('pauses for script approval (FormEdit) before rendering; edits flow through', async () => {
    const concatVideos = vi.fn(async (ids: readonly string[]) => ({
      assetId: `final[${ids.join(',')}]`,
    }))
    const meta = createIdea2VideoMeta({ concatVideos })

    // Approve path: the checkpoint fires with one editable field per generated
    // scene; approving unchanged renders all 3 with their original text.
    const a = makeCtx()
    const approved = await meta.compose({ input: { idea: 'x' } }, a.ctx)
    expect(a.askUserCalls).toHaveLength(1)
    expect(a.askUserCalls[0].kind).toBe('form')
    const fields = (a.askUserCalls[0].payload as { fields: { key: string; value: string }[] }).fields
    expect(fields.map((f) => f.value)).toEqual([
      'scene one script',
      'scene two script',
      'scene three script',
    ])
    expect(approved.sceneCount).toBe(3)

    // Edit path: editing a field's text changes THAT scene's script; the scene
    // count is fixed (FormEdit can't add/remove scenes).
    const b = makeCtx({
      approval: {
        values: {
          scene_0: 'edited one',
          scene_1: 'scene two script',
          scene_2: 'scene three script',
        },
      },
    })
    const out = await meta.compose({ input: { idea: 'x' } }, b.ctx)
    const sceneCalls = b.calls.filter((c) => c.patternId === 'meta_script2video')
    expect(sceneCalls).toHaveLength(3)
    expect(sceneCalls[0].input.sceneScript).toBe('edited one')
    expect(sceneCalls[1].input.sceneScript).toBe('scene two script')
    expect(out.sceneCount).toBe(3)
  })

  it('malformed JSON from character extraction rejects with the labeled error (not a raw SyntaxError)', async () => {
    const concatVideos = vi.fn(async () => ({ assetId: 'final' }))
    const meta = createIdea2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx({ charactersText: 'not json{' })
    await expect(meta.compose({ input: { idea: 'x' } }, ctx)).rejects.toThrow(
      'idea2video: characters: text-generation did not return valid JSON',
    )
    // Nothing paid downstream of the failed parse fired.
    expect(calls.filter((c) => c.patternId === 'meta_script2video')).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })

  it('malformed JSON from script writing rejects with the labeled error', async () => {
    const concatVideos = vi.fn(async () => ({ assetId: 'final' }))
    const meta = createIdea2VideoMeta({ concatVideos })
    const { ctx, calls } = makeCtx({ scriptText: 'not json{' })
    await expect(meta.compose({ input: { idea: 'x' } }, ctx)).rejects.toThrow(
      'idea2video: script: text-generation did not return valid JSON',
    )
    expect(calls.filter((c) => c.patternId === 'meta_script2video')).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })

  it('empty characters / script arrays from text-generation reject (Zod .min(1))', async () => {
    const concatVideos = vi.fn(async () => ({ assetId: 'final' }))
    const meta = createIdea2VideoMeta({ concatVideos })

    const a = makeCtx({ charactersText: JSON.stringify({ characters: [] }) })
    await expect(meta.compose({ input: { idea: 'x' } }, a.ctx)).rejects.toThrow()
    expect(a.calls.filter((c) => c.patternId === 'meta_script2video')).toHaveLength(0)

    const b = makeCtx({ scriptText: JSON.stringify({ script: [] }) })
    await expect(meta.compose({ input: { idea: 'x' } }, b.ctx)).rejects.toThrow()
    expect(b.calls.filter((c) => c.patternId === 'meta_script2video')).toHaveLength(0)
    expect(concatVideos).not.toHaveBeenCalled()
  })
})
