import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildAlwaysLoadDescriptors } from '../catalog-builder'
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
