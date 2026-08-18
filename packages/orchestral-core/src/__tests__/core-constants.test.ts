import { describe, expect, it } from 'vitest'

import {
  ASSET_MARKER,
  DEFAULT_SUBAGENT_BLOCKLIST,
  LIFT_MARKER,
} from '../index'

// Phase 4 runtime-freeze gate for semantically load-bearing value exports.
describe('@orchestral/core constants', () => {
  // DEFAULT_SUBAGENT_BLOCKLIST drives the recursion guard: anything whose id
  // matches an idPrefix / patternId is pruned from a sub-agent's catalog so it
  // physically cannot emit a recursive dispatch. Changing it changes which
  // Patterns sub-agents can reach.
  it('DEFAULT_SUBAGENT_BLOCKLIST is pinned', () => {
    expect(DEFAULT_SUBAGENT_BLOCKLIST).toMatchInlineSnapshot(`
      {
        "idPrefixes": [
          "agent_",
        ],
        "patternIds": [],
      }
    `)
  })

  // The marker symbols are a cross-package contract: the host stamps fields
  // with them and OSS reads only their presence. They use `Symbol.for` so the
  // registry key (the `.description`) is the actual wire contract and must stay
  // byte-stable across package duplication in node_modules.
  it('marker symbol registry keys are pinned', () => {
    expect(LIFT_MARKER.description).toBe('orchestral.lift')
    expect(ASSET_MARKER.description).toBe('orchestral.hostAsset')
    // Confirm they are global-registry symbols (Symbol.for), not local symbols.
    expect(LIFT_MARKER).toBe(Symbol.for('orchestral.lift'))
    expect(ASSET_MARKER).toBe(Symbol.for('orchestral.hostAsset'))
  })
})
