import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern } from '@orchestral/core'
import { PatternRegistry } from '@orchestral/core'
import { handleFindPattern } from '../find-pattern'
import { PatternSearchIndex } from '../pattern-search-index'

// Regression: the registry indexed a Pattern under `namespace ?? inferNamespace(id)`
// while the search index's modality filter compared the BARE `Pattern.namespace`
// field. A Pattern that declared no namespace was therefore registered under an
// inferred one but could never satisfy a modality filter. Both sides now go
// through `resolveNamespace`.

function atomic(id: string, namespace?: string): Pattern {
  return {
    id,
    kind: 'atomic',
    ...(namespace ? { namespace } : {}),
    primary: {
      tool: {
        description: `generate ${id} output from a prompt`,
        inputs: z.object({ prompt: z.string() }),
      },
    },
    outputs: z.object({ modality: z.literal('image') }),
  } as unknown as Pattern
}

function buildIndex(patterns: Pattern[]): PatternSearchIndex {
  const registry = new PatternRegistry()
  for (const p of patterns) registry.register(p)
  return new PatternSearchIndex(registry)
}

describe('modality filter vs namespace inference', () => {
  it('matches an atomic Pattern that declared no namespace', () => {
    const index = buildIndex([atomic('text-to-image')])

    const res = handleFindPattern(index, {
      query: 'generate from a prompt',
      modality: 'image',
    })

    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-image'])
  })

  it('routes an undeclared Pattern to its inferred namespace, not another one', () => {
    const index = buildIndex([atomic('text-to-speech')])

    expect(
      handleFindPattern(index, { query: 'generate from a prompt', modality: 'audio' })
        .matches.map((m) => m.patternId),
    ).toEqual(['text-to-speech'])
    expect(
      handleFindPattern(index, { query: 'generate from a prompt', modality: 'image' })
        .matches,
    ).toHaveLength(0)
  })

  it('counts modality drops in droppedBy instead of losing them silently', () => {
    const index = buildIndex([atomic('text-to-image'), atomic('text-to-video')])

    const res = handleFindPattern(index, {
      query: 'generate from a prompt',
      modality: 'audio',
    })

    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.droppedBy.modality).toBe(2)
    expect(res.diagnostic?.suggestion).toContain('audio')
  })

  it('leaves an unrecognised id uncategorized rather than answering image', () => {
    const index = buildIndex([atomic('vendor-special-capability')])

    const res = handleFindPattern(index, {
      query: 'generate from a prompt',
      modality: 'image',
    })

    expect(res.matches).toHaveLength(0)
    expect(res.diagnostic?.droppedBy.modality).toBe(1)
  })

  it('namespace: selector reaches Patterns registered under an inferred namespace', () => {
    const index = buildIndex([atomic('text-to-image')])

    const res = handleFindPattern(index, { query: 'namespace:image-gen' })

    expect(res.matches.map((m) => m.patternId)).toEqual(['text-to-image'])
  })
})
