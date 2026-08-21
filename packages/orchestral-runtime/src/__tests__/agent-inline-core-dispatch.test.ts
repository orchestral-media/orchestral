// ADR-030 §4.1 — dispatch-level integration tests for inline-core routing.
//
// The pure-function unit tests (agent-inline-core.test.ts / agent-depth.test.ts)
// only lock buildAgentInlineCore / countAgentAncestors in isolation. They do
// NOT exercise dispatchAgent's onToolCall, which is where both claims below
// actually live:
//
//   • I1: an inline-core descriptor advertises a tool whose `name` is the
//     pattern id (e.g. an always-load atomic). When the LLM calls it,
//     onToolCall must route it through the dispatch_pattern path — NOT fall
//     through to UNKNOWN_TOOL (the dead-tool bug).
//   • I2 (depth): an agent reached through 2 meta ancestors + 1 agent ancestor
//     under maxAgentDepth=2 must NOT trip AGENT_DEPTH_EXCEEDED — the gate counts
//     agent ancestors only (countAgentAncestors), not total visited size.
//
// Harness mirrors agent-asset-flow.test.ts: real InlineRuntime over an
// in-memory JobStore + a scripted fake AgentRunImpl that drives onToolCall.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AtomicPattern,
  CapabilityRouter,
  ExecutionContext,
  MetaPattern,
  ModelCapability,
  Modality,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'
import type { AgentRunImpl } from '../agent-run'

// Router that resolves any capability to a model whose call echoes a typed
// text output — enough for an atomic dispatch to complete.
function makeRouter(): CapabilityRouter {
  const cap = {
    modelId: 'fake:m',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })

// An always-load atomic — buildAgentInlineCore renders it as an inline-core
// descriptor whose `name` IS the pattern id.
function inlineAtomic(): AtomicPattern {
  return {
    id: 'inline_atomic',
    kind: 'atomic',
    description: 'an always-load atomic exposed inline to the agent loop',
    exposure: 'agent-tool',
    exposureMode: 'always-load',
    outputs: TEXT_OUTPUT,
    primary: {
      tool: {
        description: 'do the inline thing',
        inputs: z.object({ prompt: z.string() }),
      },
    },
  } as unknown as AtomicPattern
}

interface ToolStep {
  name: string
  input: unknown
  callId: string
}
function makeRunImpl(opts: {
  script?: ToolStep[]
  capture?: { results: unknown[] }
}): AgentRunImpl {
  return {
    async run(args) {
      for (const step of opts.script ?? []) {
        const res = await args.onToolCall({
          name: step.name,
          input: step.input,
          callId: step.callId,
        })
        opts.capture?.results.push(res)
      }
      // Complete the loop via the injected finish tool (default finish
      // contract). Kept out of `capture` so tests assert only their scripted
      // dispatch results.
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      return { text: 'done' }
    },
  }
}

describe('ADR-030 §4.1 — inline-core dispatch routing (review I1/B1)', () => {
  function agentWithInlineCore(): AgentPattern {
    return {
      id: 'agent_inline_host',
      kind: 'agent',
      description: 'agent whose loop.toolPatternIds includes an always-load atomic',
      primary: {
        tool: { description: 'run', inputs: z.object({ prompt: z.string() }) },
      },
      loop: {
        system: 'you are a test agent',
        toolPatternIds: ['inline_atomic'],
        modelTags: [],
      },
    } as unknown as AgentPattern
  }

  it('routes an inline-core tool call (name = pattern id) into dispatch, not UNKNOWN_TOOL', async () => {
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      // The LLM calls the inline-core tool by its pattern id directly — NO
      // dispatch_pattern wrapper (that's the whole point of inline core).
      script: [{ name: 'inline_atomic', input: { prompt: 'go' }, callId: 'tc-1' }],
    })
    const registry = new PatternRegistry()
    registry.register(inlineAtomic())
    registry.register(agentWithInlineCore())
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
    })

    const job = await rt.submitJob({
      patternId: 'agent_inline_host',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(capture.results).toHaveLength(1)

    const result = capture.results[0] as { code?: string }
    // The bug (B1): inline-core names fell through to UNKNOWN_TOOL. After the
    // fix the call routes through dispatch_pattern and returns the atomic's
    // typed output (no error code).
    expect(result?.code).not.toBe('UNKNOWN_TOOL')
    expect(result).toEqual({ modality: 'text', text: 'ok' })
  })
})

describe('ADR-030 §10.7 — agent depth gate counts agent ancestors only (review I2)', () => {
  // Chain: agent_root --(onToolCall)--> meta_x --(ctx.step)--> meta_y
  //        --(ctx.step)--> agent_leaf.
  // At agent_leaf's dispatchAgent the visited set = {agent_root, meta_x, meta_y}
  // → 1 agent ancestor. With maxAgentDepth=2 this must pass; the legacy
  // `visited.size > max` logic (size=3) would have wrongly thrown.
  function makeStepMeta(id: string, childPatternId: string): MetaPattern {
    return {
      id,
      kind: 'meta',
      description: `meta forwarding to ${childPatternId}`,
      tool: { description: id, inputs: z.object({ prompt: z.string() }) },
      outputs: z.object({ done: z.boolean() }),
      async compose(
        args: { input: unknown },
        ctx: ExecutionContext,
      ) {
        return ctx.step({
          patternId: childPatternId,
          input: { prompt: (args.input as { prompt?: string }).prompt ?? 'x' },
        })
      },
    } as unknown as MetaPattern
  }

  function agentRoot(): AgentPattern {
    return {
      id: 'agent_root',
      kind: 'agent',
      description: 'root agent that dispatches a meta chain',
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: {
        system: 'root',
        toolPatternIds: ['meta_x'],
        modelTags: [],
      },
    } as unknown as AgentPattern
  }

  function agentLeaf(): AgentPattern {
    return {
      id: 'agent_leaf',
      kind: 'agent',
      description: 'leaf agent reached after 2 metas + 1 agent ancestor',
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: {
        system: 'leaf',
        toolPatternIds: [],
        modelTags: [],
      },
    } as unknown as AgentPattern
  }

  it('does not trip AGENT_DEPTH_EXCEEDED at 2 meta + 1 agent ancestors (maxAgentDepth=2)', async () => {
    const leafRan = { value: false }
    const registry = new PatternRegistry()
    registry.register(agentRoot())
    registry.register(makeStepMeta('meta_x', 'meta_y'))
    registry.register(makeStepMeta('meta_y', 'agent_leaf'))
    registry.register(agentLeaf())

    // Each agent's run impl: root drives the meta dispatch via onToolCall;
    // leaf just records that its loop body ran (proving the gate let it in).
    const runImpl: AgentRunImpl = {
      async run(args) {
        if (args.patternId === 'agent_root') {
          await args.onToolCall({
            name: 'dispatch_pattern',
            input: { pattern_id: 'meta_x', input: { prompt: 'go' } },
            callId: 'tc-root',
          })
        } else if (args.patternId === 'agent_leaf') {
          leafRan.value = true
        }
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'done', deliverables: [] },
          callId: 'finish',
        })
        return { text: 'done' }
      },
    }

    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      maxAgentDepth: 2,
    })

    const job = await rt.submitJob({
      patternId: 'agent_root',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    // The leaf agent's loop actually executed — i.e. dispatchAgent did NOT
    // reject it with AGENT_DEPTH_EXCEEDED before reaching the run impl.
    expect(leafRan.value).toBe(true)
  })
})
