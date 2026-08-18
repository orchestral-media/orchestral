// ADR-028 P2 — dispatchAgent tool catalog.
//
// Locks the OSS-side contract after the host-tool-policy move: dispatchAgent
// emits the Path-5 router tools (find_pattern / dispatch_pattern), the injected
// finish tool (complete_task), and forwards the AgentPattern's `pattern.id` to
// AgentRunImpl.run({ patternId }). Host-tool assembly/filtering (injection +
// visibility policy) no longer lives in OSS; the host injects its per-agent tool
// surface in a later task, keyed by patternId.
//
// The minimal {store: undefined, router: {resolve}} shape from the task brief
// can't reach agentRunImpl.run — submitJob touches store.findByIdempotencyKey /
// store.insert first. So we mirror the real harness used by
// agent-asset-flow.test.ts (in-memory JobStore + real router) and capture the
// args handed to a fake AgentRunImpl.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  CapabilityRouter,
  ModelCapability,
  Modality,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntimeAdapter, type AgentAssetBridge } from '../inline'
import type { AgentRunImpl } from '../agent-run'

function makeRouter(): CapabilityRouter {
  const cap = {
    modelId: 'm',
    provider: 'p',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

// A default-finish agent — declares neither finish nor outputs, so registration
// backfills the default trio (finish = summary + deliverables, outputs =
// {assets, summary, stepCount}).
function makeAgent(): AgentPattern {
  return {
    id: 'agent_test',
    kind: 'agent',
    description: 'test agent',
    primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
    loop: {
      system: () => 'sys',
      toolPatternIds: [],
      modelTags: [],
    },
  } as unknown as AgentPattern
}

type RunArgs = Parameters<AgentRunImpl['run']>[0]

// Drives a minimal valid default finish so a loop completes cleanly.
function finishOk(args: RunArgs): Promise<unknown> {
  return args.onToolCall({
    name: args.finishToolName,
    input: { summary: 'ok', deliverables: [] },
    callId: 'finish',
  })
}

type RejectedError = Error & { code?: string; producedAssets?: readonly string[] }

// Awaits a promise expected to reject and returns the thrown Error (typed with
// the finish-broker's error extras).
async function expectReject(p: Promise<unknown>): Promise<RejectedError> {
  try {
    await p
    throw new Error('expected the promise to reject, but it resolved')
  } catch (e) {
    return e as RejectedError
  }
}

describe('dispatchAgent tool catalog (ADR-028 P2)', () => {
  it('emits find_pattern + dispatch_pattern + complete_task and forwards pattern.id', async () => {
    let capturedTools: string[] = []
    let capturedPatternId: string | undefined
    const registry = new PatternRegistry()
    registry.add(makeAgent())
    const runImpl: AgentRunImpl = {
      async run(args) {
        capturedTools = args.tools.map((t) => t.name)
        capturedPatternId = args.patternId
        await finishOk(args)
        return { text: 'ok' }
      },
    }
    const runtime = new InlineRuntimeAdapter({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
    })
    await runtime.submitJob({ patternId: 'agent_test', input: { prompt: 'hi' } })
    expect(capturedTools.sort()).toEqual(['complete_task', 'dispatch_pattern', 'find_pattern'])
    expect(capturedPatternId).toBe('agent_test')
  })
})

// The host's agent-loop model resolution (session pick / chat-model fallback)
// keys off run-args sessionId — if dispatchAgent drops spec.sessionId on the
// way to AgentRunImpl.run, agent loops silently lose session-scoped model
// overrides. Locks the spec.sessionId → run-args wire.
describe('dispatchAgent sessionId wiring', () => {
  function makeRuntime(capture: { args?: RunArgs }): InlineRuntimeAdapter {
    const registry = new PatternRegistry()
    registry.add(makeAgent())
    const runImpl: AgentRunImpl = {
      async run(args) {
        capture.args = args
        await finishOk(args)
        return { text: 'ok' }
      },
    }
    return new InlineRuntimeAdapter({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
    })
  }

  it('forwards spec.sessionId to AgentRunImpl.run', async () => {
    const capture: { args?: RunArgs } = {}
    await makeRuntime(capture).submitJob({
      patternId: 'agent_test',
      input: { prompt: 'hi' },
      sessionId: 'sess-wire-1',
    })
    expect(capture.args).toBeDefined()
    expect(capture.args?.sessionId).toBe('sess-wire-1')
  })

  it('leaves sessionId absent when the spec has none', async () => {
    const capture: { args?: RunArgs } = {}
    await makeRuntime(capture).submitJob({
      patternId: 'agent_test',
      input: { prompt: 'hi' },
    })
    expect(capture.args).toBeDefined()
    expect(capture.args?.sessionId).toBeUndefined()
  })
})

// ── Finish broker (2026-07-18 agent finish contract §5) ────────────────────
//
// The finish tool's lifecycle now lives in OSS: dispatchAgent injects a
// schema-visible complete_task descriptor, intercepts its call (validate +
// resolve deliverable handles), records the last valid finish, and composes
// Pattern outputs from the recorded payload + run facts. Two errors self-heal
// as tool-results (INVALID_FINISH / UNRESOLVED_DELIVERABLE); a missing bridge
// throws (host-config bug); a loop that never validly finishes throws a
// positive AGENT_INCOMPLETE.
describe('dispatchAgent finish broker', () => {
  // Default-finish agent (registration backfills finish + outputs).
  function makeDefaultAgent(): AgentPattern {
    return {
      id: 'agent_default',
      kind: 'agent',
      description: 'agent using the default finish contract',
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: { system: () => 'sys', toolPatternIds: [], modelTags: [] },
    } as unknown as AgentPattern
  }

  // Custom finish whose compose throws — exercises AGENT_FINISH_COMPOSE_THREW.
  function makeThrowingComposeAgent(): AgentPattern {
    return {
      id: 'agent_bad_compose',
      kind: 'agent',
      description: 'agent whose finish.compose throws',
      outputs: z.object({ ok: z.boolean() }),
      finish: {
        inputs: z.object({ summary: z.string() }),
        compose: () => {
          throw new Error('compose boom')
        },
      },
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: { system: () => 'sys', toolPatternIds: [], modelTags: [] },
    } as unknown as AgentPattern
  }

  // Custom finish whose compose returns cleanly but produces a shape that
  // doesn't parse against pattern.outputs — exercises AGENT_OUTPUT_COMPOSE_MISMATCH.
  function makeMismatchedComposeAgent(): AgentPattern {
    return {
      id: 'agent_bad_shape',
      kind: 'agent',
      description: 'agent whose finish.compose returns the wrong shape',
      outputs: z.object({ x: z.string() }),
      finish: {
        inputs: z.object({ summary: z.string() }),
        compose: () => ({ y: 1 }),
      },
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: { system: () => 'sys', toolPatternIds: [], modelTags: [] },
    } as unknown as AgentPattern
  }

  // Custom finish whose compose throws ONLY when the run facts omit `usage`. The
  // salvage path (post-finish infra failure) composes without usage, so this trips
  // compose specifically during salvage — exercising the salvage guard.
  function makeSalvageComposeThrowsAgent(): AgentPattern {
    return {
      id: 'agent_salvage_boom',
      kind: 'agent',
      description: 'agent whose finish.compose throws when the salvage facts omit usage',
      outputs: z.object({ ok: z.boolean() }),
      finish: {
        inputs: z.object({ summary: z.string() }),
        compose: (_payload: unknown, facts: { usage?: unknown }) => {
          if (facts.usage === undefined) throw new Error('compose needs usage')
          return { ok: true }
        },
      },
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: { system: () => 'sys', toolPatternIds: [], modelTags: [] },
    } as unknown as AgentPattern
  }

  // Extractor agent — lifts typed output from the final text; gets no finish
  // tool.
  function makeExtractorAgent(): AgentPattern {
    return {
      id: 'agent_extractor',
      kind: 'agent',
      description: 'agent that lifts output from final text',
      outputs: z.object({ plan: z.string() }),
      primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
      loop: {
        system: () => 'sys',
        toolPatternIds: [],
        modelTags: [],
        outputExtractor: (text: string) => ({ plan: text }),
      },
    } as unknown as AgentPattern
  }

  function makeBridge(overrides: Partial<AgentAssetBridge> = {}): AgentAssetBridge {
    return {
      buildSeedAnnouncement: () => null,
      resolveForDispatch: () => [],
      recordOutput: (a) => a.output,
      recordedAssetIds: () => [],
      resolveHandles: () => [],
      ...overrides,
    }
  }

  function makeRuntime(opts: {
    pattern: AgentPattern
    drive: (args: RunArgs) => Promise<{ text: string; usage?: { totalTokens?: number } }>
    bridge?: AgentAssetBridge
  }): InlineRuntimeAdapter {
    const registry = new PatternRegistry()
    registry.add(opts.pattern)
    const runImpl: AgentRunImpl = { run: (args) => opts.drive(args) }
    return new InlineRuntimeAdapter({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      ...(opts.bridge ? { assetBridge: opts.bridge } : {}),
    })
  }

  // (1)
  it('a valid finish with deliverables composes the default output envelope', async () => {
    const bridge = makeBridge({
      resolveHandles: ({ handles }) =>
        handles.map((h) => ({ slot: 'deliverable', assetId: `asset-of-${h}`, modality: 'image', handle: h })),
    })
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      bridge,
      drive: async (args) => {
        args.onStepFinish?.({ stepIndex: 0, toolCalls: [], text: '' })
        args.onStepFinish?.({ stepIndex: 1, toolCalls: [], text: '' })
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'made a picture', deliverables: [{ handle: 'image_1', label: 'Hero' }] },
          callId: 'f1',
        })
        return { text: 'all done' }
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    expect(job.output).toEqual({
      assets: [{ assetId: 'asset-of-image_1', modality: 'image', label: 'Hero' }],
      summary: 'made a picture',
      stepCount: 2,
    })
  })

  // (2)
  it('an invalid payload returns INVALID_FINISH and an unfinished loop throws AGENT_INCOMPLETE', async () => {
    const results: unknown[] = []
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      drive: async (args) => {
        // summary is required (min 1) — the empty string fails.
        results.push(
          await args.onToolCall({ name: args.finishToolName, input: { summary: '' }, callId: 'f1' }),
        )
        return { text: 'gave up' }
      },
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }),
    )
    const r = results[0] as { error?: string; note?: string }
    expect(r.error).toBe('INVALID_FINISH')
    expect(r.note).toBeUndefined() // no prior valid finish → no note
    expect(err.code).toBe('AGENT_INCOMPLETE')
    expect(err.message).toMatch(/without a valid complete_task call/)
  })

  // (3)
  it('a resolveHandles failure returns UNRESOLVED_DELIVERABLE with the bridge .error detail', async () => {
    // Production bridge shape: message is the opaque 'ASSET_RESOLUTION_FAILED'
    // code; the actionable detail (which handle, why) rides on `.error`.
    const bridge = makeBridge({
      resolveHandles: () => {
        throw Object.assign(new Error('ASSET_RESOLUTION_FAILED'), {
          error: { code: 'HANDLE_NOT_FOUND', handle: 'image_9' },
        })
      },
    })
    const results: unknown[] = []
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      bridge,
      drive: async (args) => {
        results.push(
          await args.onToolCall({
            name: args.finishToolName,
            input: { summary: 'done', deliverables: [{ handle: 'image_9' }] },
            callId: 'f1',
          }),
        )
        return { text: 'x' }
      },
    })
    await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }).catch(() => {})
    const r = results[0] as {
      error?: string
      detail?: { code?: string; handle?: string }
      hint?: string
    }
    expect(r.error).toBe('UNRESOLVED_DELIVERABLE')
    // The model must see the failing handle + code, carried structurally on
    // `detail` — not smuggled inside the human message string.
    expect(r.detail).toEqual({ code: 'HANDLE_NOT_FOUND', handle: 'image_9' })
    expect(r.hint).toMatch(/exactly as they appear/)
  })

  // (4)
  it('a second valid finish overwrites the first (last-write-wins)', async () => {
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      drive: async (args) => {
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'first' }, callId: 'f1' })
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'second' }, callId: 'f2' })
        return { text: 'x' }
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    expect((job.output as { summary: string }).summary).toBe('second')
  })

  // (5)
  it('a loop that never finishes throws AGENT_INCOMPLETE carrying producedAssets', async () => {
    const bridge = makeBridge({ recordedAssetIds: () => ['produced-1', 'produced-2'] })
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      bridge,
      drive: async () => ({ text: 'I answered in prose and never finished' }),
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }),
    )
    expect(err.code).toBe('AGENT_INCOMPLETE')
    expect(err.producedAssets).toEqual(['produced-1', 'produced-2'])
  })

  // (6)
  it('deliverables with no bridge injected throws AGENT_ASSET_BRIDGE_MISSING', async () => {
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      // no bridge
      drive: async (args) => {
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'done', deliverables: [{ handle: 'image_1' }] },
          callId: 'f1',
        })
        return { text: 'x' }
      },
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }),
    )
    expect(err.code).toBe('AGENT_ASSET_BRIDGE_MISSING')
    expect(err.message).toMatch(/AGENT_ASSET_BRIDGE_MISSING/)
  })

  // (7)
  it('a finish.compose that throws surfaces AGENT_FINISH_COMPOSE_THREW', async () => {
    const runtime = makeRuntime({
      pattern: makeThrowingComposeAgent(),
      drive: async (args) => {
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'done' }, callId: 'f1' })
        return { text: 'x' }
      },
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_bad_compose', input: { prompt: 'go' } }),
    )
    expect(err.code).toBe('AGENT_FINISH_COMPOSE_THREW')
    expect(err.message).toMatch(/compose boom/)
  })

  // (8)
  it('a finish.compose that returns a shape outputs.parse rejects surfaces AGENT_OUTPUT_COMPOSE_MISMATCH', async () => {
    const runtime = makeRuntime({
      pattern: makeMismatchedComposeAgent(),
      drive: async (args) => {
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'done' }, callId: 'f1' })
        return { text: 'x' }
      },
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_bad_shape', input: { prompt: 'go' } }),
    )
    expect(err.code).toBe('AGENT_OUTPUT_COMPOSE_MISMATCH')
    expect(err.message).toMatch(/AGENT_OUTPUT_COMPOSE_MISMATCH/)
  })

  // (9)
  it('a non-abort run() rejection after a valid finish salvages the composed output', async () => {
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      drive: async (args) => {
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'saved' }, callId: 'f1' })
        throw new Error('worker died after finish')
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    expect((job.output as { summary: string }).summary).toBe('saved')
    expect((job.output as { assets: unknown[] }).assets).toEqual([])
  })

  // (10)
  it('an outputExtractor pattern gets no finish tool and lifts output from text', async () => {
    let capturedTools: string[] = []
    const runtime = makeRuntime({
      pattern: makeExtractorAgent(),
      drive: async (args) => {
        capturedTools = args.tools.map((t) => t.name)
        return { text: 'the final plan' }
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_extractor', input: { prompt: 'go' } })
    expect(capturedTools).not.toContain('complete_task')
    expect(job.status).toBe('done')
    expect(job.output).toEqual({ plan: 'the final plan' })
  })

  // (11)
  it('an invalid finish after a valid one keeps the prior finish and returns a note', async () => {
    const results: unknown[] = []
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      drive: async (args) => {
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'good one' }, callId: 'f1' })
        results.push(
          await args.onToolCall({ name: args.finishToolName, input: { summary: '' }, callId: 'f2' }),
        )
        return { text: 'x' }
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } })
    const r = results[0] as { error?: string; note?: string }
    expect(r.error).toBe('INVALID_FINISH')
    expect(r.note).toMatch(/previous valid finish/)
    // The prior valid finish still governs the output.
    expect(job.status).toBe('done')
    expect((job.output as { summary: string }).summary).toBe('good one')
  })

  // (12)
  it('an empty-deliverables finish needs no bridge and completes with assets:[]', async () => {
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      // no bridge
      drive: async (args) => {
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'text only', deliverables: [] },
          callId: 'f1',
        })
        return { text: 'x' }
      },
    })
    const job = await runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    expect(job.output).toEqual({ assets: [], summary: 'text only', stepCount: 0 })
  })

  // (13)
  it('a salvage whose compose throws surfaces the original run() error (with producedAssets) and marks the envelope errored', async () => {
    // Built inline (not via makeRuntime) so we can hold the store reference and
    // capture the internally-generated jobId to inspect its envelope.
    const store = new MemoryJobStore()
    let jobId: string | undefined
    const unsub = store.subscribe((ev) => {
      jobId ??= ev.job.id
    })
    const registry = new PatternRegistry()
    registry.add(makeSalvageComposeThrowsAgent())
    const bridge = makeBridge({ recordedAssetIds: () => ['salvage-produced-1'] })
    const runImpl: AgentRunImpl = {
      async run(args) {
        // A valid finish lands, then the run rejects (worker death) → salvage.
        await args.onToolCall({ name: args.finishToolName, input: { summary: 'saved' }, callId: 'f1' })
        throw new Error('worker died after finish')
      },
    }
    const runtime = new InlineRuntimeAdapter({
      store: store as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      assetBridge: bridge,
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_salvage_boom', input: { prompt: 'go' } }),
    )
    unsub()
    // The ORIGINAL infra failure propagates — the guard neither re-salvages nor
    // leaks the compose error.
    expect(err.message).toMatch(/worker died after finish/)
    expect(err.producedAssets).toEqual(['salvage-produced-1'])
    // A failed salvage still records an errored envelope.
    expect(jobId).toBeDefined()
    expect(runtime.getAgentEnvelope(jobId as string)?.status).toBe('errored')
  })

  // (14)
  it('a missing bridge on a SECOND finish is not masked by the first finish', async () => {
    // The first finish carries no deliverables, so it validates and is recorded.
    // The second names one — with no bridge injected that throws the fail-loud
    // host-config error. Salvage must not quietly recompose the earlier finish
    // and report success; the host bug has to reach the caller.
    const runtime = makeRuntime({
      pattern: makeDefaultAgent(),
      // no bridge
      drive: async (args) => {
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'first pass', deliverables: [] },
          callId: 'f1',
        })
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'now with art', deliverables: [{ handle: 'image_1' }] },
          callId: 'f2',
        })
        return { text: 'x' }
      },
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }),
    )
    expect(err.code).toBe('AGENT_ASSET_BRIDGE_MISSING')
  })

  // (15)
  it('an abort right after a valid finish does not salvage the run', async () => {
    // Cancel is a deliberate stop, not an infra failure — the recorded finish
    // must NOT be recomposed into a completed envelope behind the user's back.
    const store = new MemoryJobStore()
    let jobId: string | undefined
    const unsub = store.subscribe((ev) => {
      jobId ??= ev.job.id
    })
    const registry = new PatternRegistry()
    registry.add(makeDefaultAgent())
    let runtime!: InlineRuntimeAdapter
    const runImpl: AgentRunImpl = {
      async run(args) {
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'saved' },
          callId: 'f1',
        })
        await runtime.cancelJob(jobId as string)
        throw new DOMException('aborted', 'AbortError')
      },
    }
    runtime = new InlineRuntimeAdapter({
      store: store as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
    })
    const err = await expectReject(
      runtime.submitJob({ patternId: 'agent_default', input: { prompt: 'go' } }),
    )
    unsub()
    expect(err.name).toBe('AbortError')
    expect((await store.get(jobId as string))?.status).toBe('cancelled')
    // cancelJob drops the envelope; a salvage would have written a 'completed'
    // one straight back over it.
    expect(runtime.getAgentEnvelope(jobId as string)).toBeUndefined()
  })
})
