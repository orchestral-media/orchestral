import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildAlwaysLoadDescriptors } from '../catalog-builder'
import type { Pattern } from '../pattern'

describe('buildAlwaysLoadDescriptors', () => {
  it('inline 一个 exposureMode:always-load 的 atomic(取 primary.tool.description/inputs)', () => {
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

  it('inline 一个 exposureMode:always-load 的 meta(取 tool.description/tool.inputs)', () => {
    const meta = {
      id: 'meta_idea2video',
      kind: 'meta',
      exposureMode: 'always-load',
      tool: { description: 'idea to multi-scene video', inputs: z.object({ idea: z.string() }) },
      outputs: z.object({}),
      compose: async () => ({}),
    } as unknown as Pattern
    const out = buildAlwaysLoadDescriptors([meta])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('meta_idea2video')
    expect(out[0].description).toBe('idea to multi-scene video')
    expect(out[0].inputSchema).toBeTruthy()
  })

  it('不 inline 未标 always-load 的 meta', () => {
    const meta = {
      id: 'meta_plain',
      kind: 'meta',
      tool: { description: 'x', inputs: z.object({}) },
      outputs: z.object({}),
      compose: async () => ({}),
    } as unknown as Pattern
    expect(buildAlwaysLoadDescriptors([meta])).toHaveLength(0)
  })

  it('inline 一个 exposureMode:always-load 的 agent(取 primary.tool.description/inputs)', () => {
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

  it('不 inline 一个 always-load 但无 primary 的 host-only agent', () => {
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
