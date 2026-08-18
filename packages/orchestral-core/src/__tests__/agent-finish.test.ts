import { describe, expect, it } from 'vitest'
import {
  AGENT_FINISH_TOOL_NAME,
  buildFinishDescriptor,
  defaultAgentFinishCompose,
  defaultAgentFinishInputs,
  defaultAgentFinishOutputs,
} from '../agent-finish'

describe('default agent finish trio', () => {
  it('inputs: deliverables default to [] (text-only finish is legal)', () => {
    const p = defaultAgentFinishInputs.parse({ summary: 'done' })
    expect(p.deliverables).toEqual([])
  })
  it('compose closes the loop: compose(inputs, facts) parses against outputs', () => {
    const finish = defaultAgentFinishInputs.parse({
      summary: 'made a bunny',
      deliverables: [{ handle: 'image_1', label: 'main' }],
    })
    const out = defaultAgentFinishCompose(finish, {
      stepCount: 7,
      deliverables: [
        { slot: 'deliverable', assetId: 'a-1', modality: 'image', handle: 'image_1', label: 'main' },
      ],
    })
    expect(() => defaultAgentFinishOutputs.parse(out)).not.toThrow()
    expect(out).toEqual({
      assets: [{ assetId: 'a-1', modality: 'image', label: 'main' }],
      summary: 'made a bunny',
      stepCount: 7,
    })
  })
  it('descriptor: JSON Schema, wire name preserved', () => {
    const d = buildFinishDescriptor(defaultAgentFinishInputs)
    expect(d.name).toBe(AGENT_FINISH_TOOL_NAME)
    expect(d.name).toBe('complete_task')
    const js = d.inputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(js.properties ?? {})).toEqual(
      expect.arrayContaining(['summary', 'deliverables']),
    )
    // Contract lock: deliverables stays required-with-default. The model must
    // explicitly state its deliverables ([] is a legal, deliberate answer);
    // the default only guards against a schema-shape regression dropping it.
    expect(js.required).toEqual(
      expect.arrayContaining(['summary', 'deliverables']),
    )
  })
  it('inputs: empty summary is rejected (min(1))', () => {
    expect(defaultAgentFinishInputs.safeParse({ summary: '' }).success).toBe(
      false,
    )
  })
  it('inputs: empty deliverable handle is rejected (min(1))', () => {
    expect(
      defaultAgentFinishInputs.safeParse({
        summary: 'done',
        deliverables: [{ handle: '' }],
      }).success,
    ).toBe(false)
  })
  it('compose: no resolved deliverables → assets: [] and parses against outputs', () => {
    const finish = defaultAgentFinishInputs.parse({ summary: 'text only' })
    const out = defaultAgentFinishCompose(finish, {
      stepCount: 3,
      deliverables: [],
    })
    expect(out.assets).toEqual([])
    expect(() => defaultAgentFinishOutputs.parse(out)).not.toThrow()
  })
})
