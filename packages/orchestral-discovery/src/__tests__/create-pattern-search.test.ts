// createPatternSearch — the ready-made `PatternSearch` a host injects.
//
// @orchestral/runtime no longer imports this package; it takes a
// `PatternSearch` and the host wires one. What that seam must keep promising
// its caller is locked here: the request's corpus scoping is honoured
// (includeOnly / excludeIds / audience), the router the factory closed over
// filters unsatisfiable atomics, and the value handed back is the same
// `FindPatternResult` handleFindPattern returns. QUERY_SYNTAX_HINT is the
// other half of the split — the prose core stopped carrying.
//
// Fixtures mirror find-pattern.test.ts next door.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { CapabilityRouter, Pattern } from '@orchestral/core'
import { silentDiagnosticsLogger, PatternRegistry } from '@orchestral/core'
import { createPatternSearch } from '../create-pattern-search'
import { QUERY_SYNTAX_HINT } from '../find-pattern'

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

function buildRegistry(patterns: Pattern[]): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p)
  return registry
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
]

describe('createPatternSearch', () => {
  it('answers a free-form query with ranked matches', async () => {
    const search = createPatternSearch(buildRegistry(corpus()))
    const res = await search({
      input: { query: 'create picture' },
      audience: 'chat-turn',
    })
    expect(res.matches.map((m) => m.patternId)).toContain('text-to-image')
    expect(res.query).toBe('create picture')
  })

  it('honours the caller-owned includeOnly scoping', async () => {
    const search = createPatternSearch(buildRegistry(corpus()))
    const res = await search({
      input: { query: 'select:text-to-image,image-to-image' },
      audience: 'agent-loop',
      includeOnly: new Set(['image-to-image']),
    })
    expect(res.matches.map((m) => m.patternId)).toEqual(['image-to-image'])
  })

  it('honours the caller-owned excludeIds scoping', async () => {
    const search = createPatternSearch(buildRegistry(corpus()))
    const res = await search({
      input: { query: 'select:text-to-image' },
      audience: 'agent-loop',
      excludeIds: new Set(['text-to-image']),
    })
    expect(res.matches).toEqual([])
  })

  it('drops atomics the injected router cannot satisfy', async () => {
    const router: CapabilityRouter = {
      checkSatisfiable: (capability) =>
        capability === 'text-to-image'
          ? { ok: true, candidates: [] }
          : { ok: false, reason: 'no-model-in-catalog', candidates: [] },
      resolve: () => {
        throw new Error('resolve is not discovery\'s business')
      },
    }
    const search = createPatternSearch(buildRegistry(corpus()), { router })
    const res = await search({
      input: { query: 'select:text-to-image,text-to-video' },
      audience: 'chat-turn',
    })
    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-image'])
    expect(res.satisfiabilityFiltered).toBe(true)
  })

  it('sees patterns registered after the seam was created', async () => {
    const registry = buildRegistry(corpus())
    const search = createPatternSearch(registry)
    registry.register(
      atomic('text-to-speech', {
        namespace: 'audio-gen',
        description: 'synthesize speech audio from text',
      }),
    )
    const res = await search({
      input: { query: 'select:text-to-speech' },
      audience: 'chat-turn',
    })
    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-speech'])
  })
})

describe('QUERY_SYNTAX_HINT', () => {
  it('carries the syntax this package parses', () => {
    expect(QUERY_SYNTAX_HINT).toContain('select:')
    expect(QUERY_SYNTAX_HINT).toContain('namespace:')
    expect(QUERY_SYNTAX_HINT).toContain('+')
  })

  // The tokenizer splits CJK, so a Chinese query returns matches and looks
  // like it worked — against an English catalog they are the wrong matches.
  // "prefer English" alone does not say that, which is why the sentence is
  // separate and why it is asserted separately: it went missing once already,
  // in the move that brought this string out of @orchestral/core.
  it('keeps the CJK caveat, not just the English preference', () => {
    expect(QUERY_SYNTAX_HINT).toContain('CJK')
    expect(QUERY_SYNTAX_HINT).toContain(
      'only match catalog text written in that language',
    )
  })
})
