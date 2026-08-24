import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern } from '@orchestral/core'
import { silentDiagnosticsLogger, PatternRegistry } from '@orchestral/core'
import { handleFindPattern } from '../find-pattern'
import { PatternSearchIndex } from '../pattern-search-index'

// Lightweight Pattern fixtures — cast through unknown so we only declare the
// fields find_pattern / the search index actually read (kind, primary/tool,
// outputs, namespace, exposure, searchHint). Mirrors the harness in
// catalog-builder.test.ts.

function atomic(
  id: string,
  opts: {
    namespace?: string
    description?: string
    searchHint?: string
    exposure?: 'tool' | 'agent-tool' | 'no-tool'
  } = {},
): Pattern {
  return {
    id,
    kind: 'atomic',
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    ...(opts.exposure ? { exposure: opts.exposure } : {}),
    ...(opts.searchHint ? { searchHint: opts.searchHint } : {}),
    primary: {
      tool: {
        description: opts.description ?? `do ${id}`,
        inputs: z.object({ prompt: z.string() }),
      },
    },
    outputs: z.object({ modality: z.literal('image') }),
  } as unknown as Pattern
}

function meta(
  id: string,
  opts: { description?: string; searchHint?: string } = {},
): Pattern {
  return {
    id,
    kind: 'meta',
    namespace: 'meta-pipelines',
    ...(opts.searchHint ? { searchHint: opts.searchHint } : {}),
    tool: {
      description: opts.description ?? `pipeline ${id}`,
      inputs: z.object({ idea: z.string() }),
    },
    outputs: z.object({ modality: z.literal('video') }),
    compose: async () => ({}),
  } as unknown as Pattern
}

function buildIndex(patterns: Pattern[]): PatternSearchIndex {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p)
  return new PatternSearchIndex(registry)
}

const corpus = (): Pattern[] => [
  atomic('text-to-image', {
    namespace: 'image-gen',
    description: 'generate an image from a text prompt',
    searchHint: 'create picture',
  }),
  atomic('image-to-image', {
    namespace: 'image-gen',
    description: 'edit an existing image',
  }),
  atomic('text-to-video', {
    namespace: 'video-gen',
    description: 'generate a video clip',
  }),
  meta('meta_brief2video', { description: 'brief to multi-scene video' }),
  meta('meta_storyboard', { description: 'build a storyboard pipeline' }),
]

describe('handleFindPattern — select: exact selection', () => {
  it('select:<full id> returns that pattern, bypassing BM25', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'select:meta_brief2video' })
    expect(res.matches.map((m) => m.patternId)).toEqual(['meta_brief2video'])
    expect(res.matches[0]!.kind).toBe('meta')
  })

  it('select:<short-name> resolves via registry.resolveShortName', () => {
    // Use a prefixed id so the short name differs from the full id.
    const prefixed = {
      id: 'ns/fancy-edit',
      kind: 'atomic',
      namespace: 'image-gen',
      primary: {
        tool: { description: 'fancy edit', inputs: z.object({ x: z.string() }) },
      },
      outputs: z.object({ modality: z.literal('image') }),
    } as unknown as Pattern
    const index = buildIndex([...corpus(), prefixed])
    const res = handleFindPattern(index, { query: 'select:fancy-edit' })
    expect(res.matches.map((m) => m.patternId)).toEqual(['ns/fancy-edit'])
  })

  it('select:a,b returns multiple in listed order, deduped', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, {
      query: 'select:meta_brief2video,text-to-image,meta_brief2video',
    })
    expect(res.matches.map((m) => m.patternId)).toEqual([
      'meta_brief2video',
      'text-to-image',
    ])
  })

  it('select:<unknown> returns empty matches + diagnostic naming the id', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'select:does-not-exist' })
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('does-not-exist')
  })

  it('select: still applies exposure filter (agent-tool hidden from chat-turn)', () => {
    const index = buildIndex([
      ...corpus(),
      atomic('agent-only-cap', {
        namespace: 'image-gen',
        exposure: 'agent-tool',
      }),
    ])
    const res = handleFindPattern(
      index,
      { query: 'select:agent-only-cap' },
      { audience: 'chat-turn' },
    )
    expect(res.matches).toHaveLength(0)
    // visible to agent-loop audience
    const res2 = handleFindPattern(
      index,
      { query: 'select:agent-only-cap' },
      { audience: 'agent-loop' },
    )
    expect(res2.matches.map((m) => m.patternId)).toEqual(['agent-only-cap'])
  })

  it('select: still applies excludeIds', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'select:text-to-image,text-to-video' },
      { excludeIds: new Set(['text-to-image']) },
    )
    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-video'])
  })
})

describe('handleFindPattern — exact id short-circuit', () => {
  it('a bare query equal to a pattern id short-circuits to that pattern', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'image-to-image' })
    expect(res.matches.map((m) => m.patternId)).toEqual(['image-to-image'])
  })

  it('a bare query equal to a short name short-circuits', () => {
    const prefixed = {
      id: 'ns/solo-cap',
      kind: 'atomic',
      namespace: 'image-gen',
      primary: {
        tool: { description: 'solo', inputs: z.object({ x: z.string() }) },
      },
      outputs: z.object({ modality: z.literal('image') }),
    } as unknown as Pattern
    const index = buildIndex([...corpus(), prefixed])
    const res = handleFindPattern(index, { query: 'solo-cap' })
    expect(res.matches.map((m) => m.patternId)).toEqual(['ns/solo-cap'])
  })
})

describe('handleFindPattern — prefix / namespace grouping', () => {
  it('meta_* returns all ids with that prefix, bypassing BM25', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'meta_*' })
    expect(res.matches.map((m) => m.patternId).sort()).toEqual([
      'meta_brief2video',
      'meta_storyboard',
    ])
  })

  it('namespace:<ns> returns the whole namespace', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'namespace:image-gen' })
    expect(res.matches.map((m) => m.patternId).sort()).toEqual([
      'image-to-image',
      'text-to-image',
    ])
  })

  it('namespace:<ns>:* glob form is equivalent', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'namespace:video-gen:*' })
    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-video'])
  })

  it('prefix grouping still respects kind filter', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, {
      query: 'namespace:image-gen',
      kind: 'meta',
    })
    expect(res.matches).toHaveLength(0)
  })

  it('empty group (no member / no match) returns empty + diagnostic', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'nothing_*' })
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic).toBeTruthy()
  })
})

describe('handleFindPattern — directToolIds diagnostic (P4)', () => {
  // Agent-loop setup: direct tools are in the index/registry but excluded
  // from the search corpus via includeOnly (agent-dispatch.ts's
  // findPatternIncludeOnly).
  const agentScope = {
    includeOnly: new Set(['meta_brief2video']),
    directToolIds: new Set(['image-to-image', 'text-to-image']),
    audience: 'agent-loop' as const,
  }

  it('exact-id query hitting a direct tool says so instead of "no match"', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'image-to-image' }, agentScope)
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('image-to-image')
    expect(res.diagnostic?.suggestion).toContain('direct tool')
  })

  it('prose query without the id substring does NOT hint (no BM25 oracle)', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      {
        query: 'edit an existing image with a text prompt',
        kind: 'atomic',
        modality: 'image',
      },
      { ...agentScope, directToolIds: new Set(['image-to-image']) },
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion ?? '').not.toContain('direct tool')
  })

  it('multi-word query containing a direct tool id in spaced form hints', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      // No kind filter needed: BM25 stopword filtering (#165) keeps the
      // shared 'to' from matching meta_brief2video, so this is a genuine
      // zero-match and the direct-tool override fires.
      { query: 'image to image inpainting mask' },
      { ...agentScope, directToolIds: new Set(['image-to-image']) },
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('image-to-image')
    expect(res.diagnostic?.suggestion).toContain('direct tool')
  })

  it('select: comma list of direct-tool ids hints instead of generic no-match', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'select:image-to-image,text-to-image' },
      agentScope,
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('direct tool')
  })

  it('multi-word query with trailing punctuation still hints', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      // No kind filter needed post-#165 stopword filtering (see above).
      { query: 'use image-to-image!' },
      { ...agentScope, directToolIds: new Set(['image-to-image']) },
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('image-to-image')
    expect(res.diagnostic?.suggestion).toContain('direct tool')
  })

  it('select:<direct-tool-id> gets the direct-tool hint too', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'select:image-to-image' },
      agentScope,
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('direct tool')
  })

  it('no directToolIds → behaviour unchanged', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'image-to-image' },
      { includeOnly: new Set(['meta_brief2video']) },
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('No Patterns matched')
  })

  it('query sharing no terms with any direct tool keeps the generic diagnostic', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'transcribe podcast subtitles' },
      agentScope,
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).not.toContain('direct tool')
  })

  it('stopword-only overlap with a direct tool does NOT hint (BM25 false-positive regression)', () => {
    // Old BM25 fallback matched text-to-image via the stopword "a" in its
    // description and named the WRONG tool with an imperative hint.
    const index = buildIndex(corpus())
    const res = handleFindPattern(
      index,
      { query: 'transcribe a podcast episode' },
      { ...agentScope, directToolIds: new Set(['text-to-image']) },
    )
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion ?? '').not.toContain('direct tool')
  })
})

describe('handleFindPattern — BM25 regression', () => {
  it('plain keyword query still ranks via BM25', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'generate video clip' })
    const ids = res.matches.map((m) => m.patternId)
    expect(ids).toContain('text-to-video')
    // BM25 path reports totalCandidates from the ranked corpus.
    expect(res.totalCandidates).toBeGreaterThan(0)
  })

  it('a multi-word query is not mistaken for an exact id', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'create picture' })
    // searchHint "create picture" boosts text-to-image to the top.
    expect(res.matches[0]!.patternId).toBe('text-to-image')
  })

  it('stopword overlap alone does not surface unrelated patterns', () => {
    // meta_brief2video's description "brief to multi-scene video" shares only
    // the stopword 'to' with this query — without stopword filtering it
    // surfaced as a confident match, misleading the dispatching LLM.
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, {
      query: 'image to image inpainting mask',
    })
    expect(res.matches.map((m) => m.patternId)).not.toContain(
      'meta_brief2video',
    )
  })

  it('an all-stopword query returns the zero-match diagnostic, not noise hits', () => {
    const index = buildIndex(corpus())
    const res = handleFindPattern(index, { query: 'to the and of' })
    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.suggestion).toContain('No Patterns matched')
  })
})
