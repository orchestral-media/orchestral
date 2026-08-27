// The retrieval seam (`InlineRuntimeInit.patternSearch`).
//
// Two claims, and together they are cross-cutting#2 on the runtime side:
//
//   • No seam → the agent loop's catalog does not advertise `find_pattern`,
//     and a loop that emits the name anyway gets UNKNOWN_TOOL whose message
//     and hint do not name a tool this catalog cannot have. Advertising a
//     tool whose only possible answer is "nothing is wired" spends prefix
//     bytes and buys a round-trip the model cannot complete.
//   • Seam → `find_pattern` is in the catalog, the call reaches the seam with
//     the scoping dispatchAgent owns (audience, the toolPatternIds allowlist
//     minus inline core, the ancestor/self excludes, the direct tools), and
//     the seam's value comes back to the loop verbatim.
//
// The scoping half is a security invariant, not ergonomics: `includeOnly` is
// what keeps a subagent's discovery inside its declared loop.toolPatternIds,
// and the LLM can neither see nor widen it.
//
// Harness mirrors agent-inline-core-dispatch.test.ts: a real InlineRuntime
// over an in-memory JobStore plus a scripted fake AgentRunImpl that drives
// onToolCall directly.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AtomicPattern,
  CapabilityRouter,
  Modality,
  ModelCapability,
  PatternSearch,
  PatternSearchRequest,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  InMemoryJobStore as MemoryJobStore,
  PatternRegistry,
} from '@orchestral/core'

import { InlineRuntime } from '../inline'
import type { AgentRunImpl } from '../agent-run'

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

// Always-load → rendered as a DIRECT tool (inline core), so it is outside the
// search corpus and inside `directToolIds`.
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

// No exposureMode → not inline core, so discovery is the only way to it.
function searchableAtomic(): AtomicPattern {
  return {
    id: 'searchable_atomic',
    kind: 'atomic',
    description: 'a deferred atomic the loop can only reach through discovery',
    exposure: 'agent-tool',
    outputs: TEXT_OUTPUT,
    primary: {
      tool: {
        description: 'do the searchable thing',
        inputs: z.object({ prompt: z.string() }),
      },
    },
  } as unknown as AtomicPattern
}

function seamAgent(): AgentPattern {
  return {
    id: 'agent_seam',
    kind: 'agent',
    description: 'agent whose allowlist mixes an inline-core and a deferred atomic',
    primary: {
      tool: { description: 'run', inputs: z.object({ prompt: z.string() }) },
    },
    loop: {
      system: 'you are a test agent',
      toolPatternIds: ['inline_atomic', 'searchable_atomic'],
      modelTags: [],
    },
  } as unknown as AgentPattern
}

// Records the catalog the loop was handed and the result of one scripted
// find_pattern call, then finishes cleanly through the injected finish tool.
function makeRunImpl(capture: {
  tools: string[]
  results: unknown[]
}): AgentRunImpl {
  return {
    async run(args) {
      capture.tools = args.tools.map((t) => t.name)
      capture.results.push(
        await args.onToolCall({
          name: 'find_pattern',
          input: { query: 'do the searchable thing' },
          callId: 'tc-1',
        }),
      )
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      return { text: 'done' }
    },
  }
}

function makeRegistry(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(inlineAtomic())
  registry.register(searchableAtomic())
  registry.register(seamAgent())
  return registry
}

describe('agent catalog without a patternSearch seam', () => {
  it('advertises no find_pattern tool, and refuses the name without naming it', async () => {
    const capture = { tools: [] as string[], results: [] as unknown[] }
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(),
      agentRunImpl: makeRunImpl(capture),
    })

    const job = await rt.submitJob({
      patternId: 'agent_seam',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    expect(capture.tools).not.toContain('find_pattern')
    expect(capture.tools).toContain('dispatch_pattern')
    // The inline core is a static part of the catalog — no search involved,
    // so it is untouched by the seam being absent.
    expect(capture.tools).toContain('inline_atomic')

    const res = capture.results[0] as {
      code?: string
      message?: string
      hint?: string
    }
    expect(res.code).toBe('UNKNOWN_TOOL')
    // The message echoes the name the loop emitted — it must, or the model
    // cannot tell WHICH of its calls was refused. What neither half may do is
    // present find_pattern as something this catalog has: the list of what is
    // exposed omits it, and the hint sends the model to dispatch_pattern
    // rather than back to a tool that is not there.
    expect(res.message).toContain(
      "catalog exposes host tools, dispatch_pattern",
    )
    expect(res.hint).not.toContain('find_pattern')
  })
})

describe('agent catalog with a patternSearch seam', () => {
  it('advertises find_pattern and hands the call to the seam with the loop\'s own scoping', async () => {
    const seen: PatternSearchRequest[] = []
    const answer = { matches: [{ patternId: 'searchable_atomic' }] }
    const patternSearch: PatternSearch = async (req) => {
      seen.push(req)
      return answer
    }
    const capture = { tools: [] as string[], results: [] as unknown[] }
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(),
      agentRunImpl: makeRunImpl(capture),
      patternSearch,
    })

    const job = await rt.submitJob({
      patternId: 'agent_seam',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')
    expect(capture.tools).toContain('find_pattern')

    // The seam's value reaches the loop verbatim — including from an async
    // implementation, which is what a hosted search would be.
    expect(capture.results[0]).toEqual(answer)

    expect(seen).toHaveLength(1)
    const req = seen[0]!
    expect(req.input.query).toBe('do the searchable thing')
    expect(req.audience).toBe('agent-loop')
    // Corpus = allowlist ∖ inline core.
    expect([...(req.includeOnly ?? [])]).toEqual(['searchable_atomic'])
    expect([...(req.directToolIds ?? [])]).toEqual(['inline_atomic'])
    // Self-exclusion: the agent cannot rediscover itself.
    expect([...(req.excludeIds ?? [])]).toContain('agent_seam')
  })

  it('still validates the model\'s input before the seam sees it', async () => {
    const seen: PatternSearchRequest[] = []
    const patternSearch: PatternSearch = (req) => {
      seen.push(req)
      return { matches: [] }
    }
    const results: unknown[] = []
    const runImpl: AgentRunImpl = {
      async run(args) {
        results.push(
          await args.onToolCall({
            name: 'find_pattern',
            // `query` is `.min(1)` — an empty one never reaches retrieval.
            input: { query: '' },
            callId: 'tc-1',
          }),
        )
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
      registry: makeRegistry(),
      router: makeRouter(),
      agentRunImpl: runImpl,
      patternSearch,
    })

    await rt.submitJob({ patternId: 'agent_seam', input: { prompt: 'start' } })
    const res = results[0] as { error?: string; tool?: string }
    expect(res.error).toBe('INVALID_INPUT')
    expect(res.tool).toBe('find_pattern')
    expect(seen).toHaveLength(0)
  })
})
