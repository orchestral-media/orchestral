// Catalog smoke test — the claim the example exists to keep true: the six
// long-form patterns compile against the public @orchestral/* surface, register
// next to the whole shipped catalog, and the director's tool list resolves
// against that registry. Nothing is dispatched, so nothing is paid; the
// per-pattern tests next door drive each compose() on a fake ctx, and
// script-planning-dispatch-e2e runs one of them through the real runtime on a
// scripted model.
//
// It also pins the registry's authoring lint where it stands: the four
// text-producing long-form metas predate the bounded output vocabulary and
// are flagged; the shipped catalog is not, and neither is meta_idea2video,
// whose output is the bounded assets[] envelope. A shipped pattern showing up
// in that list is a regression in @orchestral/patterns, not in this example.

import { describe, expect, it } from 'vitest'
import { PatternRegistry, type DiagnosticsLogger } from '@orchestral/core'
import { LONG_FORM_PATTERN_IDS, registerCatalog, type LongFormHostOps } from '../catalog'
import { createLongFormVideoAgent } from '../patterns/agent-long-form-video'
import { LONG_FORM_VIDEO_DIRECTOR_PROMPT } from '../patterns/agent-long-form-video/prompts'

/** Host ops — stubs; nothing composes in this test, so none is ever called. */
const ops: LongFormHostOps = {
  concatVideos: async () => ({ assetId: 'v' }),
  stillToVideo: async () => ({ assetId: 'v' }),
  addBackgroundAudio: async () => ({ assetId: 'v' }),
  addSubtitles: async () => ({ assetId: 'v' }),
  createSubtitleAsset: async () => ({ assetId: 's' }),
  recordSessionAsset: async () => ({ handle: 'image_1' }),
}

function register() {
  const warned: string[] = []
  const logger: DiagnosticsLogger = {
    warn: (message) => {
      warned.push(message)
    },
    error: (message) => {
      warned.push(message)
    },
  }
  const registry = new PatternRegistry({ logger })
  const catalog = registerCatalog(registry, ops)
  return { registry, warned, ...catalog }
}

describe('long-form-video catalog', () => {
  it('registers the shipped catalog plus the six long-form patterns, each under its own id', () => {
    const { registry, shipped, longForm } = register()

    // 10 atomics + via-caption + 7 metas from the package, 5 metas + 1 agent
    // from this example.
    expect(shipped).toHaveLength(18)
    expect(longForm).toEqual([...LONG_FORM_PATTERN_IDS])
    expect(registry.size()).toBe(24)

    for (const id of [...shipped, ...longForm]) {
      expect(registry.has(id), `${id} registered`).toBe(true)
    }
    // The ids are load-bearing literals (hashed into idempotency keys, written
    // into job rows) — pinned here the way @orchestral/patterns pins its own.
    expect(LONG_FORM_PATTERN_IDS).toEqual([
      'meta_script-planning',
      'meta_prose-chunking',
      'meta_novel-to-events',
      'meta_event-to-script',
      'meta_idea2video',
      'agent_long-form-video',
    ])
    // The kind prefix is the contract inferNamespace and the sub-agent guard
    // route on.
    expect(registry.get('agent_long-form-video')?.kind).toBe('agent')
    for (const id of longForm.filter((x) => x.startsWith('meta_'))) {
      expect(registry.get(id)?.kind).toBe('meta')
    }
  })

  it("the director's tool list resolves against this registry, and its one host tool is named nowhere in it", () => {
    const { registry } = register()
    const director = createLongFormVideoAgent()

    for (const id of director.loop.toolPatternIds) {
      expect(registry.has(id), `tool ${id} registered`).toBe(true)
    }
    // The nested pipeline: the director dispatches script2video per scene,
    // script2video and idea2video need concatVideos, and the director's own
    // final concat is a HOST TOOL the prompt names — not a pattern, and not a
    // MetaCommonDeps op. A host that forgets it gets a director that cannot
    // finish.
    expect(LONG_FORM_VIDEO_DIRECTOR_PROMPT).toContain('`concat_videos`')
    expect(registry.has('concat_videos')).toBe(false)
  })

  it('the registry lint names the long-form metas and nothing shipped', () => {
    const { warned, shipped, longForm } = register()

    const flagged = new Set(
      warned
        .map((line) => /OUTPUTS_UNBOUNDED_FIELDS \((.+?)\)/.exec(line)?.[1])
        .filter((id): id is string => id !== undefined),
    )
    // The shipped catalog is bounded end to end (pinned in @orchestral/patterns).
    for (const id of shipped) {
      expect(flagged.has(id), `${id} must not be flagged`).toBe(false)
    }
    // The metas moved here unchanged. Four of them return text and their
    // outputs still carry bare z.string() fields — the lint is doing its job,
    // and bounding them is the first thing to do if they ever ship again.
    expect([...flagged].sort()).toEqual(
      [
        'meta_script-planning',
        'meta_prose-chunking',
        'meta_novel-to-events',
        'meta_event-to-script',
      ].sort(),
    )
    // meta_idea2video returns only the labelled assets[] envelope plus a
    // count, which is bounded already; the agent declares no outputs (the
    // registry backfills the bounded default finish envelope). Neither is
    // flagged.
    expect(flagged.has('meta_idea2video')).toBe(false)
    expect(flagged.has('agent_long-form-video')).toBe(false)
    expect(longForm).toContain('meta_idea2video')
  })
})
