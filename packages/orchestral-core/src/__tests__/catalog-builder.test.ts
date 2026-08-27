import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildAlwaysLoadDescriptors, buildCatalogDescriptors } from '../catalog-builder'
import type { Pattern } from '../pattern'

describe('buildAlwaysLoadDescriptors', () => {
  it('inlines an atomic with exposureMode:always-load (taking primary.tool.description/inputs)', () => {
    const atomic = {
      id: 'text-to-image',
      kind: 'atomic',
      exposureMode: 'always-load',
      primary: {
        tool: { description: 'generate an image', inputs: z.object({ prompt: z.string() }) },
      },
      outputs: z.object({}),
    } as unknown as Pattern
    const out = buildAlwaysLoadDescriptors([atomic])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('text-to-image')
    expect(out[0].description).toBe('generate an image')
    expect(out[0].inputSchema).toBeTruthy()
  })

  it('inlines a meta with exposureMode:always-load (taking tool.description/tool.inputs)', () => {
    const meta = {
      id: 'meta_storyboard',
      kind: 'meta',
      exposureMode: 'always-load',
      tool: { description: 'scene to multi-panel storyboard', inputs: z.object({ scene: z.string() }) },
      outputs: z.object({}),
      compose: async () => ({}),
    } as unknown as Pattern
    const out = buildAlwaysLoadDescriptors([meta])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('meta_storyboard')
    expect(out[0].description).toBe('scene to multi-panel storyboard')
    expect(out[0].inputSchema).toBeTruthy()
  })

  it('does not inline a meta that is not marked always-load', () => {
    const meta = {
      id: 'meta_plain',
      kind: 'meta',
      tool: { description: 'x', inputs: z.object({}) },
      outputs: z.object({}),
      compose: async () => ({}),
    } as unknown as Pattern
    expect(buildAlwaysLoadDescriptors([meta])).toHaveLength(0)
  })

  it('inlines an agent with exposureMode:always-load (taking primary.tool.description/inputs)', () => {
    const agent = {
      id: 'agent_orchestrator',
      kind: 'agent',
      exposureMode: 'always-load',
      primary: {
        tool: {
          description: 'orchestrate a multi-step media task',
          inputs: z.object({ prompt: z.string() }),
        },
      },
      outputs: z.object({}),
      loop: { system: '', toolPatternIds: [], modelTags: [] },
    } as unknown as Pattern
    const out = buildAlwaysLoadDescriptors([agent])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('agent_orchestrator')
    expect(out[0].description).toBe('orchestrate a multi-step media task')
    expect(out[0].inputSchema).toBeTruthy()
  })

  it('does not inline an always-load host-only agent that has no primary', () => {
    const hostOnlyAgent = {
      id: 'agent_cron',
      kind: 'agent',
      exposureMode: 'always-load',
      outputs: z.object({}),
      loop: { system: '', toolPatternIds: [], modelTags: [] },
    } as unknown as Pattern
    expect(buildAlwaysLoadDescriptors([hostOnlyAgent])).toHaveLength(0)
  })
})

// exposure is the negative filter, exposureMode is the load strategy — they
// compose in that order. Without the first half, a Pattern hidden from every
// LLM catalog still got promoted into the tool table here while find_pattern
// dropped it: two paths, opposite answers.
describe('buildAlwaysLoadDescriptors — exposure gate', () => {
  const alwaysLoadAtomic = (id: string, exposure?: unknown): Pattern =>
    ({
      id,
      kind: 'atomic',
      exposureMode: 'always-load',
      ...(exposure !== undefined ? { exposure } : {}),
      primary: {
        tool: { description: `d:${id}`, inputs: z.object({ prompt: z.string() }) },
      },
      outputs: z.object({}),
    }) as unknown as Pattern

  it("does not inline an always-load atomic marked exposure:'no-tool'", () => {
    expect(buildAlwaysLoadDescriptors([alwaysLoadAtomic('secret_op', 'no-tool')])).toHaveLength(0)
  })

  it('does not inline an always-load atomic whose object-form exposure closes the surface', () => {
    const p = alwaysLoadAtomic('half_open', { chatTurn: false, agentLoop: true })
    expect(buildAlwaysLoadDescriptors([p])).toHaveLength(0)
  })

  it("an unnamed surface fails closed: {} exposes nothing (resolveExposure's own rule)", () => {
    expect(buildAlwaysLoadDescriptors([alwaysLoadAtomic('unnamed', {})])).toHaveLength(0)
  })

  it("surface:'agentLoop' inlines an agent-tool Pattern that the chat-turn surface hides", () => {
    const p = alwaysLoadAtomic('video-to-frames', 'agent-tool')
    expect(buildAlwaysLoadDescriptors([p])).toHaveLength(0)
    const forLoop = buildAlwaysLoadDescriptors([p], { surface: 'agentLoop' })
    expect(forLoop.map((d) => d.name)).toEqual(['video-to-frames'])
  })

  it('the default surface is chat-turn, so an undeclared exposure still inlines', () => {
    const out = buildAlwaysLoadDescriptors([alwaysLoadAtomic('text-to-image')])
    expect(out.map((d) => d.name)).toEqual(['text-to-image'])
  })

  it('the gate applies to meta and agent kinds too', () => {
    const meta = {
      id: 'meta_internal',
      kind: 'meta',
      exposureMode: 'always-load',
      exposure: 'no-tool',
      tool: { description: 'internal pipeline', inputs: z.object({}) },
      outputs: z.object({}),
      compose: async () => ({}),
    } as unknown as Pattern
    const agent = {
      id: 'agent_internal',
      kind: 'agent',
      exposureMode: 'always-load',
      exposure: 'no-tool',
      primary: { tool: { description: 'internal agent', inputs: z.object({}) } },
      outputs: z.object({}),
      loop: { system: '', toolPatternIds: [], modelTags: [] },
    } as unknown as Pattern
    expect(buildAlwaysLoadDescriptors([meta, agent])).toHaveLength(0)
  })
})

// The two router descriptors are a catalog's fixed head, but `find_pattern` is
// only honest when something can answer it — retrieval is an injected seam
// (@orchestral/runtime's `InlineRuntimeInit.patternSearch`), and the query
// mini-language belongs to whichever implementation is behind that seam.
describe('buildCatalogDescriptors', () => {
  it('emits find_pattern + dispatch_pattern by default', () => {
    const out = buildCatalogDescriptors()
    expect(out.map((d) => d.name)).toEqual(['find_pattern', 'dispatch_pattern'])
  })

  it('omits find_pattern when includeFindPattern is false, keeping dispatch_pattern', () => {
    const out = buildCatalogDescriptors({ includeFindPattern: false })
    expect(out.map((d) => d.name)).toEqual(['dispatch_pattern'])
  })

  it('appends querySyntaxHint to the find_pattern description', () => {
    const hint = 'Prefix a word with + to make it mandatory.'
    const out = buildCatalogDescriptors({ querySyntaxHint: hint })
    const find = out.find((d) => d.name === 'find_pattern')
    expect(find?.description.endsWith(hint)).toBe(true)
  })

  it('says nothing about a query syntax when no hint is passed', () => {
    const find = buildCatalogDescriptors().find((d) => d.name === 'find_pattern')
    // Every shape @orchestral/discovery's QUERY_SYNTAX_HINT teaches. A bare
    // '+' is deliberately not asserted on: the stock text says "modality +
    // producesAssets" about what a match RETURNS, which is not a query syntax
    // and not a claim about anyone's parser.
    for (const implementationSyntax of [
      'select:',
      'namespace:',
      '+term',
      'mandatory',
      'tokeniz',
    ]) {
      expect(find?.description).not.toContain(implementationSyntax)
    }
  })
})
