// The find_pattern wire contract must not describe one retrieval
// implementation's query language. The `+term` / `select:` / `namespace:` /
// `<prefix>*` mini-language is parsed entirely inside @orchestral/discovery;
// a host that swaps retrieval swaps the syntax with it, and gets the prose
// back into the tool description through
// `BuildCatalogDescriptorsOptions.querySyntaxHint`. This test is the
// compile-time-less link between the two halves: it fails the moment core
// starts speaking for an implementation again.
import { describe, expect, it } from 'vitest'

import { FindPatternInputSchema } from '../find-pattern-schema'

function queryDescription(): string {
  const shape = FindPatternInputSchema.shape
  return shape.query.description ?? ''
}

describe('FindPatternInputSchema.query description', () => {
  it('asks for a free-form task description', () => {
    expect(queryDescription()).toContain('Free-form')
  })

  it('documents no selector or mandatory-term syntax', () => {
    const d = queryDescription()
    for (const implementationSyntax of ['select:', 'namespace:', '+', '*']) {
      expect(d).not.toContain(implementationSyntax)
    }
  })

  it('makes no claim about how a query is tokenized', () => {
    expect(queryDescription().toLowerCase()).not.toContain('token')
  })
})
