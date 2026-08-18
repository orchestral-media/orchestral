import { describe, expect, it } from 'vitest'

import { resolveExposure } from '../pattern'
import type { ResolvedExposure } from '../pattern'

// ADR-030 §3.3 / D6 — resolveExposure normalizes the PatternExposure union
// (string shorthand / per-surface object / undefined) into a fully-resolved
// per-surface boolean set. Back-compat shorthands must map to the exact same
// semantics the old string-comparison consumers enforced.

const TOOL: ResolvedExposure = {
  chatTurn: true,
  agentLoop: true,
  slash: false,
  canvas: false,
  host: true,
}

describe('resolveExposure — back-compat shorthand', () => {
  it("undefined → 'tool' default semantics (chat-turn + agent-loop visible, host open)", () => {
    expect(resolveExposure(undefined)).toEqual(TOOL)
  })

  it("'tool' → chat-turn + agent-loop visible, slash/canvas closed, host open", () => {
    expect(resolveExposure('tool')).toEqual(TOOL)
  })

  it("'agent-tool' → agent-loop only (chat-turn hidden), host open", () => {
    expect(resolveExposure('agent-tool')).toEqual({
      chatTurn: false,
      agentLoop: true,
      slash: false,
      canvas: false,
      host: true,
    })
  })

  it("'no-tool' → no LLM surface, host still open (host-direct never gated)", () => {
    expect(resolveExposure('no-tool')).toEqual({
      chatTurn: false,
      agentLoop: false,
      slash: false,
      canvas: false,
      host: true,
    })
  })
})

describe('resolveExposure — per-surface object form', () => {
  it('reads declared surfaces verbatim', () => {
    expect(
      resolveExposure({
        chatTurn: true,
        agentLoop: false,
        slash: true,
        canvas: true,
        host: false,
      }),
    ).toEqual({
      chatTurn: true,
      agentLoop: false,
      slash: true,
      canvas: true,
      host: false,
    })
  })

  it('fail-closed on missing LLM/user-facing surfaces; host defaults open', () => {
    expect(resolveExposure({})).toEqual({
      chatTurn: false,
      agentLoop: false,
      slash: false,
      canvas: false,
      host: true,
    })
  })

  it('a single declared surface leaves the rest fail-closed (host still open)', () => {
    expect(resolveExposure({ chatTurn: true })).toEqual({
      chatTurn: true,
      agentLoop: false,
      slash: false,
      canvas: false,
      host: true,
    })
  })

  it('host can be explicitly closed (overrides the open default)', () => {
    expect(resolveExposure({ host: false })).toEqual({
      chatTurn: false,
      agentLoop: false,
      slash: false,
      canvas: false,
      host: false,
    })
  })
})
