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
  AgentToolDescriptor,
  AtomicPattern,
  CapabilityRouter,
  Modality,
  ModelCapability,
  PatternSearch,
  PatternSearchRequest,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

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

interface Capture {
  tools: readonly AgentToolDescriptor[]
  results: unknown[]
}

function toolNames(capture: Capture): string[] {
  return capture.tools.map((t) => t.name)
}

// Records the catalog the loop was handed and the result of one scripted
// find_pattern call, then finishes cleanly through the injected finish tool.
function makeRunImpl(capture: Capture): AgentRunImpl {
  return {
    async run(args) {
      capture.tools = args.tools
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

// Same harness, but it also drives the two refusals `resolveDispatchTarget`
// writes and the loop returns verbatim: an id that resolves to nothing, and an
// id that resolves but whose input fails the zod parse.
function makeRefusalRunImpl(capture: Capture): AgentRunImpl {
  return {
    async run(args) {
      capture.tools = args.tools
      capture.results.push(
        await args.onToolCall({
          name: 'find_pattern',
          input: { query: 'do the searchable thing' },
          callId: 'tc-1',
        }),
        await args.onToolCall({
          name: 'dispatch_pattern',
          input: { pattern_id: 'no_such_pattern', input: {} },
          callId: 'tc-2',
        }),
        // In the allowlist, so it gets past every scope guard and dies on the
        // schema instead — `prompt` is required.
        await args.onToolCall({
          name: 'dispatch_pattern',
          input: { pattern_id: 'searchable_atomic', input: {} },
          callId: 'tc-3',
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

/**
 * Every string in one tool descriptor an LLM can read: the description, and
 * the `describe()` text that `toJsonSchema` folded into the input schema.
 * Serialising the schema is how a `describe` gets asserted on at all — it is
 * not reachable as a field.
 */
function modelVisibleText(tool: AgentToolDescriptor): string {
  return `${tool.description}\n${JSON.stringify(tool.inputSchema)}`
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
    const capture: Capture = { tools: [], results: [] }
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

    expect(toolNames(capture)).not.toContain('find_pattern')
    expect(toolNames(capture)).toContain('dispatch_pattern')
    // The inline core is a static part of the catalog — no search involved,
    // so it is untouched by the seam being absent.
    expect(toolNames(capture)).toContain('inline_atomic')

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

  // Dropping the descriptor is only half of "this catalog has no find_pattern".
  // The other half is every OTHER string the model reads, and those are not all
  // written here: `dispatch_pattern`'s description and its schema `describe`s
  // come from @orchestral/core's catalog-builder, and the refusals below are
  // written by core's `resolveDispatchTarget` and returned verbatim. Three
  // authorities, one claim — so the claim is asserted once, over everything the
  // model can see.
  it('names find_pattern in no description, no schema describe and no returned hint', async () => {
    const capture: Capture = { tools: [], results: [] }
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry: makeRegistry(),
      router: makeRouter(),
      agentRunImpl: makeRefusalRunImpl(capture),
    })

    const job = await rt.submitJob({
      patternId: 'agent_seam',
      input: { prompt: 'start' },
    })
    expect(job.status).toBe('done')

    // Guard the guard: a typo'd tool name would make the sweep below pass over
    // an empty catalog.
    expect(toolNames(capture)).toContain('dispatch_pattern')
    for (const tool of capture.tools) {
      expect(modelVisibleText(tool)).not.toContain('find_pattern')
    }

    // The three refusals the loop handed back, in the order they were driven.
    const [unknownTool, notFound, invalidInput] = capture.results as {
      code?: string
      hint?: string
    }[]
    expect(unknownTool?.code).toBe('UNKNOWN_TOOL')
    expect(notFound?.code).toBe('PATTERN_NOT_FOUND')
    expect(invalidInput?.code).toBe('INPUT_VALIDATION_FAILED')
    // The hint is the field that tells the model what to do next, so it is the
    // field that must not name a tool that is not there. Asserted per refusal
    // rather than over the whole payload because UNKNOWN_TOOL's `message`
    // echoes the name the model emitted — deliberately, so it can tell which
    // call was refused (pinned by the test above).
    for (const res of capture.results as { hint?: string }[]) {
      expect(typeof res.hint).toBe('string')
      expect(res.hint).not.toContain('find_pattern')
    }
    // Nothing else in the two dispatch refusals names it either: unlike
    // UNKNOWN_TOOL they echo no tool name, so the whole payload is fair game.
    expect(JSON.stringify(notFound)).not.toContain('find_pattern')
    expect(JSON.stringify(invalidInput)).not.toContain('find_pattern')
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
    const capture: Capture = { tools: [], results: [] }
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
    expect(toolNames(capture)).toContain('find_pattern')
    // The other half of the pair the unwired case asserts the absence of: with
    // a seam wired, dispatch_pattern's own copy does send the model there.
    const dispatch = capture.tools.find((t) => t.name === 'dispatch_pattern')!
    expect(modelVisibleText(dispatch)).toContain('find_pattern')

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
