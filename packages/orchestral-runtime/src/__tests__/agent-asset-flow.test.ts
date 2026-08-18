// P7d — dispatchAgent ⋈ AgentAssetBridge wiring (§5.9 ④/⑥/⑧).
// Builds a real InlineRuntime over an in-memory JobStore + a scripted fake
// AgentRunImpl (stands in for the worker LLM) + a fake AgentAssetBridge
// (stands in for the P7e host) so we can assert seed announcement, asset-free
// SystemPromptContext, inner resolve/record, and partial-result 回流.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AssetKind,
  AssetNeed,
  AssetReferences,
  AtomicPattern,
  CapabilityRouter,
  Job,
  JobError,
  ModelCapability,
  Modality,
  ResolvedAssetRef,
  SystemPromptContext,
} from '@orchestral/core'
import {
  InMemoryJobStore as MemoryJobStore,
  mintHandle,
  PatternRegistry,
} from '@orchestral/core'

import { InlineRuntime, type AgentAssetBridge } from '../inline'
import type { AgentChatMessage, AgentRunImpl } from '../agent-run'

// ── Router that resolves `image-gen` to a model whose call echoes a typed
//    output (we don't actually inspect the produced asset here — the bridge's
//    recordOutput is what threads produced handles into the ledger). ───────
function makeRouter(): CapabilityRouter {
  const cap = {
    modelId: 'fake:img',
    provider: 'fake',
    tags: [] as never[],
    capabilities: ['image-gen'] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['image'] as Modality[],
    source: 'user' as const,
    async call(_input: unknown, _ctx: unknown) {
      // DispatchResult-shaped — runtime unwraps `.output`.
      return {
        output: {
          modality: 'image',
          // Adapter output: real assetId + modality, NO handle — the bridge's
          // recordOutput mints the canonical handle at record time.
          assets: [{ assetId: 'gen-asset', modality: 'image' }],
        },
      }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

// ── Patterns ───────────────────────────────────────────────────────────────
const IMAGE_OUTPUT = z.object({
  modality: z.literal('image'),
  assets: z.array(z.object({ assetId: z.string(), modality: z.string() })),
})

const SRC_NEED: AssetNeed = {
  slot: 'source',
  modality: 'image',
  cardinality: 'single',
  required: false,
}

function imageGen(): AtomicPattern {
  return {
    id: 'image-gen',
    kind: 'atomic',
    description: 'generate / edit an image',
    exposure: 'agent-tool',
    assetNeeds: [SRC_NEED],
    outputs: IMAGE_OUTPUT,
    primary: {
      tool: {
        description: 'make an image',
        inputs: z.object({
          prompt: z.string().optional(),
          references: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        }),
      },
    },
  } as unknown as AtomicPattern
}

function agentTest(
  systemSpy?: (input: unknown, ctx: SystemPromptContext) => string,
  opts?: { inheritParentAssets?: boolean },
): AgentPattern {
  return {
    id: 'agent_test',
    kind: 'agent',
    description: 'test agent that dispatches image-gen',
    primary: {
      tool: {
        description: 'run the test agent',
        inputs: z.object({ prompt: z.string() }),
      },
    },
    loop: {
      system: systemSpy ?? 'you are a test agent',
      toolPatternIds: ['image-gen'],
      modelTags: [],
      ...(opts?.inheritParentAssets ? { inheritParentAssets: true } : {}),
    },
  } as unknown as AgentPattern
}

// ── Fake AgentAssetBridge — Map<contextId, ledger entries> + real mintHandle.
//    resolveForDispatch throws on unknown handle (fail-closed). ─────────────
interface LedgerEntry {
  assetId: string
  modality: AssetKind
  handle: string
}
class AssetResolutionError extends Error {
  constructor(public error: { code: string; handle?: string; slot?: string; meta?: unknown }) {
    super(error.code)
  }
}
class FakeBridge implements AgentAssetBridge {
  readonly ledgers = new Map<string, LedgerEntry[]>()
  readonly seedCalls: Array<{
    contextId: string
    passedIn: readonly ResolvedAssetRef[]
    inheritFromContextId?: string
  }> = []
  readonly resolveCalls: Array<{ contextId: string; input: unknown }> = []
  readonly resolveResults: ResolvedAssetRef[][] = []

  private ledger(contextId: string): LedgerEntry[] {
    let l = this.ledgers.get(contextId)
    if (!l) {
      l = []
      this.ledgers.set(contextId, l)
    }
    return l
  }

  buildSeedAnnouncement(args: {
    contextId: string
    passedIn: readonly ResolvedAssetRef[]
    inheritFromContextId?: string
  }): string | null {
    this.seedCalls.push({ ...args })
    const l = this.ledger(args.contextId)
    // Re-mint child-local handles for passed-in assets.
    for (const a of args.passedIn) {
      const prior = l.filter((e) => e.modality === a.modality).length
      l.push({ assetId: a.assetId, modality: a.modality, handle: mintHandle(a.modality, prior) })
    }
    if (args.passedIn.length === 0) return null
    return `<assets>${args.passedIn.map((a) => a.assetId).join(',')}</assets>`
  }

  resolveForDispatch(args: {
    contextId: string
    input: unknown
    assetNeeds: readonly AssetNeed[]
  }): readonly ResolvedAssetRef[] {
    this.resolveCalls.push({ contextId: args.contextId, input: args.input })
    const l = this.ledger(args.contextId)
    const refs = (args.input as { references?: AssetReferences } | null)?.references ?? {}
    const declaredSlots = args.assetNeeds.map((n) => n.slot)
    // Fail-closed: reject any key in references that isn't a declared slot.
    for (const key of Object.keys(refs)) {
      if (!declaredSlots.includes(key)) {
        throw new AssetResolutionError({
          code: 'UNKNOWN_SLOT',
          slot: key,
          meta: { declaredSlots, available: [] },
        })
      }
    }
    const out: ResolvedAssetRef[] = []
    for (const need of args.assetNeeds) {
      const raw = refs[need.slot]
      if (raw === undefined) continue // optional slot, omitted
      const handle = Array.isArray(raw) ? raw[0] : raw
      const hit = l.find((e) => e.handle === handle)
      if (!hit) throw new AssetResolutionError({ code: 'HANDLE_NOT_FOUND', handle })
      out.push({ slot: need.slot, assetId: hit.assetId, modality: hit.modality })
    }
    this.resolveResults.push(out)
    return out
  }

  readonly recordCalls: Array<{
    contextId: string
    patternId: string
    resolvedInputs: readonly ResolvedAssetRef[]
  }> = []
  recordOutput(args: {
    contextId: string
    toolCallId: string
    patternId: string
    resolvedInputs: readonly ResolvedAssetRef[]
    output: unknown
  }): unknown {
    this.recordCalls.push({
      contextId: args.contextId,
      patternId: args.patternId,
      resolvedInputs: args.resolvedInputs,
    })
    const l = this.ledger(args.contextId)
    const assets =
      (args.output as { assets?: Array<{ assetId: string; modality: AssetKind } & Record<string, unknown>> } | null)
        ?.assets ?? []
    const stampedAssets: Array<Record<string, unknown>> = []
    for (const a of assets) {
      const prior = l.filter((e) => e.modality === a.modality).length
      const handle = mintHandle(a.modality, prior)
      l.push({ assetId: a.assetId, modality: a.modality, handle })
      // Mirror the host bridge: stamp the minted handle + origin onto the
      // model-facing output so the downstream D3 projection keeps the asset.
      stampedAssets.push({ ...a, handle, origin: 'generated' })
    }
    if (assets.length === 0) return args.output
    return { ...(args.output as Record<string, unknown>), assets: stampedAssets }
  }

  resolveHandles(args: {
    contextId: string
    handles: readonly string[]
  }): readonly ResolvedAssetRef[] {
    const l = this.ledger(args.contextId)
    return args.handles.map((handle) => {
      const hit = l.find((e) => e.handle === handle)
      if (!hit) throw new AssetResolutionError({ code: 'HANDLE_NOT_FOUND', handle })
      return { slot: 'deliverable', assetId: hit.assetId, modality: hit.modality, handle }
    })
  }

  recordedAssetIds(contextId: string): readonly string[] {
    return this.ledger(contextId).map((e) => e.assetId)
  }
}

// ── Scripted AgentRunImpl. `script` is a list of tool-call steps the fake
//    worker LLM emits; the runtime's onToolCall result is captured per step.
//    `onRun` lets a test inspect args (system, messages) and override the
//    drive entirely (used by the partial-failure test). ──────────────────────
interface ToolStep {
  name: string
  input: unknown
  callId: string
}
function makeRunImpl(opts: {
  script?: ToolStep[]
  onRun?: (args: Parameters<AgentRunImpl['run']>[0]) => Promise<unknown> | unknown
  capture?: { lastArgs?: Parameters<AgentRunImpl['run']>[0]; results: unknown[] }
}): AgentRunImpl {
  return {
    async run(args) {
      if (opts.capture) opts.capture.lastArgs = args
      if (opts.onRun) {
        const r = await opts.onRun(args)
        return r as { text: string }
      }
      for (const step of opts.script ?? []) {
        const res = await args.onToolCall({ name: step.name, input: step.input, callId: step.callId })
        opts.capture?.results.push(res)
      }
      // Complete the loop via the injected finish tool (default finish
      // contract, no deliverables). Kept out of `capture`.
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      return { text: 'done' }
    },
  }
}

function buildRuntime(opts: {
  pattern: AgentPattern
  runImpl: AgentRunImpl
  bridge?: AgentAssetBridge
}): InlineRuntime {
  const registry = new PatternRegistry()
  registry.register(imageGen())
  registry.register(opts.pattern)
  return new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry,
    router: makeRouter(),
    agentRunImpl: opts.runImpl,
    ...(opts.bridge ? { assetBridge: opts.bridge } : {}),
  })
}

describe('P7d dispatchAgent ⋈ AgentAssetBridge', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = new FakeBridge()
  })

  it('subagent resolves a handle it produced earlier in the loop', async () => {
    const capture = { results: [] as unknown[] }
    const c1 = 'tc-1'
    const c2 = 'tc-2'
    const runImpl = makeRunImpl({
      capture,
      script: [
        // 1st dispatch produces image_1 → recordOutput into agent ledger.
        { name: 'dispatch_pattern', input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } }, callId: c1 },
        // 2nd dispatch references that produced handle.
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'edit it', references: { source: 'image_1' } } },
          callId: c2,
        },
      ],
    })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    const job = await rt.submitJob<{ prompt: string }, { done: boolean }>({
      patternId: 'agent_test',
      input: { prompt: 'go' },
    })
    expect(job.status).toBe('done')
    // image-gen declares assetNeeds, so the bridge resolves on every dispatch.
    // 1st call has no references → []; 2nd references the handle minted from
    // the 1st child's recorded output → resolves to the produced assetId.
    expect(bridge.resolveCalls.length).toBe(2)
    expect(bridge.resolveResults[0]).toEqual([])
    expect(bridge.resolveResults[1]).toEqual([
      { slot: 'source', assetId: 'gen-asset', modality: 'image' },
    ])
    // Both children succeeded (tool-results are the typed image outputs).
    expect(capture.results.length).toBe(2)
    // Ledger now holds the produced asset under its minted handle.
    const contextLedger = [...bridge.ledgers.values()][0]
    expect(contextLedger.some((e) => e.assetId === 'gen-asset' && e.handle === 'image_1')).toBe(true)
  })

  it('stamps the recorded handle (+ origin/from) onto the tool-result returned to the loop', async () => {
    // §6.3 D3 / breakpoint 3(a): the agent path must forward recordOutput's
    // STAMPED output (handle + origin) to the loop, not the raw adapter output
    // (assetId+url, no handle) — otherwise projectToolOutputForModel drops the
    // asset for lacking a handle and the agent sees assets:[] (the chat path
    // already stamps; agent path used to discard recordOutput's return).
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      script: [
        { name: 'dispatch_pattern', input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } }, callId: 'tc-1' },
      ],
    })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    // The tool-result the loop saw carries the minted handle + origin, NOT a
    // bare assetId-only asset element.
    const result = capture.results[0] as { assets?: Array<{ handle?: string; origin?: string }> }
    expect(result.assets?.[0]?.handle).toBe('image_1')
    expect(result.assets?.[0]?.origin).toBe('generated')
    // recordOutput received the patternId + resolved inputs for provenance.
    expect(bridge.recordCalls).toHaveLength(1)
    expect(bridge.recordCalls[0]?.patternId).toBe('image-gen')
  })

  it('passed-in assets are announced into the seed (write-once) before the prompt', async () => {
    const capture = { results: [] as unknown[], lastArgs: undefined as Parameters<AgentRunImpl['run']>[0] | undefined }
    const runImpl = makeRunImpl({ capture, script: [] })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    await rt.submitJob({
      patternId: 'agent_test',
      input: { prompt: 'go' },
      assets: [{ slot: 'source', assetId: 'x', modality: 'image' }],
    })
    // buildSeedAnnouncement called with passedIn including 'x'.
    expect(bridge.seedCalls.length).toBe(1)
    expect(bridge.seedCalls[0].passedIn.map((a) => a.assetId)).toContain('x')
    // Seed messages: announcement user message precedes the prompt user message.
    const msgs = capture.lastArgs!.messages as AgentChatMessage[]
    const announceIdx = msgs.findIndex(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<assets>'),
    )
    const promptIdx = msgs.findIndex((m) => m.role === 'user' && m.content === 'go')
    expect(announceIdx).toBeGreaterThanOrEqual(0)
    expect(promptIdx).toBeGreaterThan(announceIdx)
  })

  it('inheritParentAssets:true forwards inheritFromContextId=sessionId to the bridge', async () => {
    const runImpl = makeRunImpl({ script: [] })
    const rt = buildRuntime({ pattern: agentTest(undefined, { inheritParentAssets: true }), runImpl, bridge })
    await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' }, sessionId: 'sess-1' })
    expect(bridge.seedCalls[0].inheritFromContextId).toBe('sess-1')
  })

  it('loop.system receives a ctx WITHOUT assets', async () => {
    let capturedCtx: SystemPromptContext | undefined
    const runImpl = makeRunImpl({ script: [] })
    const pattern = agentTest((_input, ctx) => {
      capturedCtx = ctx
      return 'sys'
    })
    const rt = buildRuntime({ pattern, runImpl, bridge })
    await rt.submitJob({
      patternId: 'agent_test',
      input: { prompt: 'go' },
      assets: [{ slot: 'source', assetId: 'x', modality: 'image' }],
    })
    expect(capturedCtx).toBeDefined()
    expect('assets' in (capturedCtx as object)).toBe(false)
  })

  it('subagent reference to an unknown handle fails closed (ASSET_RESOLUTION_FAILED)', async () => {
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      script: [
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'edit', references: { source: 'image_99' } } },
          callId: 'tc-x',
        },
      ],
    })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done') // loop self-corrects; the tool-result carries the error
    const result = capture.results[0] as { code?: string; hint?: string }
    expect(result.code).toBe('ASSET_RESOLUTION_FAILED')
    expect(result.hint).toBe('Reference an asset handle in your inventory, or generate the source first.')
  })

  it('UNKNOWN_SLOT resolution error carries the slot-key hint', async () => {
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      script: [
        {
          name: 'dispatch_pattern',
          // 'bad_slot' is not declared in imageGen()'s assetNeeds — triggers UNKNOWN_SLOT.
          input: { pattern_id: 'image-gen', input: { prompt: 'edit', references: { bad_slot: 'image_1' } } },
          callId: 'tc-y',
        },
      ],
    })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    const result = capture.results[0] as { code?: string; hint?: string }
    expect(result.code).toBe('ASSET_RESOLUTION_FAILED')
    expect(result.hint).toBe("Unknown references key — use only the pattern's declared slots (see error.meta.declaredSlots).")
  })

  it('whole-agent failure attaches producedAssets to the thrown error (§5.9⑧)', async () => {
    // Worker produces image_1 via a tool call, then the whole run rejects.
    const runImpl = makeRunImpl({
      onRun: async (args) => {
        await args.onToolCall({
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } },
          callId: 'tc-1',
        })
        throw new Error('boom')
      },
    })
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge })
    // Catch the thrown error directly (submitJob rethrows the dispatch error).
    let thrown: (Error & { producedAssets?: readonly string[] }) | undefined
    let failedJob: Job | undefined
    try {
      await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    } catch (e) {
      thrown = e as Error & { producedAssets?: readonly string[] }
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toContain('boom')
    expect(thrown!.producedAssets).toEqual(['gen-asset'])
    // And the job landed in error.
    const all = await (rt as unknown as { store: MemoryJobStore }).store.query()
    failedJob = all.find((j) => j.patternId === 'agent_test')
    expect(failedJob?.status).toBe('error')
    const err = failedJob?.error as JobError | null
    expect(err).not.toBeNull()
    // §5.9⑧ — normaliseError preserves producedAssets off the thrown error
    // onto the STORED JobError. This is the observable carrier the parent
    // (chat.ts JOB_FAILED / inline SUBAGENT_TOOL_FAILED) reads to surface
    // partial产出 in its failure tool-result.
    expect(err?.producedAssets).toEqual(['gen-asset'])
  })

  it('SUBAGENT_TOOL_FAILED carries produced_assets when a dispatched child failed with partial assets (cached-error path)', async () => {
    // An agent dispatches `image-gen` as a tool. The child dispatch resolves
    // via the idempotency cache to an errored job whose JobError carries
    // producedAssets (the §5.9⑧ carrier). The cached path returns
    // child.status === 'error' (NOT a fresh throw), so inline.ts onToolCall
    // builds SUBAGENT_TOOL_FAILED — which must echo the child's producedAssets
    // as `produced_assets`.
    //
    // The child is `image-gen` (not an `agent_*` id), so it clears the
    // DEFAULT_SUBAGENT_BLOCKLIST and is in the agent's loop.toolPatternIds
    // allowlist. We can't trigger the cache via the default MemoryJobStore
    // (its findByIdempotencyKey withholds errored rows), so this test installs
    // a store whose lookup returns a pre-seeded errored child on the child
    // dispatch only.
    const capture = { results: [] as unknown[] }

    const cachedChildError: JobError = {
      code: 'IMAGE_GEN_FAILED',
      message: 'image-gen failed after producing a draft',
      producedAssets: ['partial-asset'],
    }
    const cachedChild: Job = {
      id: 'cached-child',
      patternId: 'image-gen',
      idempotencyKey: 'k-cached',
      status: 'error',
      input: { prompt: 'a cat' },
      output: null,
      error: cachedChildError,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const registry = new PatternRegistry()
    registry.register(imageGen())
    registry.register(agentTest())
    // Store whose dedup gate returns the pre-seeded errored child ONLY for the
    // child dispatch. The agent's own submit (the very first call, before
    // anything is inserted) must fall through so the agent loop actually runs
    // and reaches onToolCall.
    //
    // The hook is on insertIfAbsent because that is the runtime's only dedup
    // gate — submit no longer does a separate findByIdempotencyKey lookup.
    // Returning an errored row here deliberately breaks the store's canonical
    // rule (errored rows never dedupe); that's the point of the fixture, since
    // a conforming store cannot produce the cached-error path at all.
    class CachedStore extends MemoryJobStore {
      private dedupChecks = 0
      override async insertIfAbsent(job: Job): Promise<Job> {
        this.dedupChecks++
        if (this.dedupChecks === 1) return super.insertIfAbsent(job) // agent itself
        return cachedChild // child dispatch hits the cached errored job
      }
    }
    const runImpl = makeRunImpl({
      capture,
      script: [
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } },
          callId: 'tc-1',
        },
      ],
    })
    const rt = new InlineRuntime({
      store: new CachedStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      assetBridge: bridge,
    })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done') // agent loop self-corrects on the tool-result
    const result = capture.results[0] as { code?: string; produced_assets?: readonly string[] }
    expect(result.code).toBe('SUBAGENT_TOOL_FAILED')
    expect(result.produced_assets).toEqual(['partial-asset'])
  })
})

// §5.9 — an agent-dispatched meta resolves its SUB-STEP references against the
// agent's runId ledger (spec.assetContextId), never the chat session ledger.
// Both ledgers mint image_N handles, so a sessionId fallback would not fail —
// it would silently resolve a DIFFERENT asset. The agent stamps assetContextId
// on every tool sub-dispatch; dispatchMeta prefers it over sessionId.
describe('agent→meta sub-step asset context', () => {
  function metaStep(): AgentPattern {
    return {
      id: 'meta_step',
      kind: 'meta',
      description: 'meta forwarding a caller handle to an inner image-gen step',
      tool: {
        description: 'run the meta',
        inputs: z.object({ prompt: z.string().optional() }),
      },
      outputs: IMAGE_OUTPUT,
      compose: async (_params: unknown, ctx: { step: (ref: unknown) => Promise<{ value: unknown }> }) => {
        const { value } = await ctx.step({
          patternId: 'image-gen',
          input: { prompt: 'inner edit', references: { source: 'image_1' } },
        })
        return value
      },
    } as unknown as AgentPattern
  }

  function agentWithMeta(): AgentPattern {
    const agent = agentTest()
    return {
      ...agent,
      loop: { ...agent.loop, toolPatternIds: ['image-gen', 'meta_step'] },
    } as AgentPattern
  }

  // Pins an internal asset AND forwards a caller handle to the SAME single-
  // cardinality slot ('source', from image-gen's SRC_NEED) — the exact shape
  // assertNoDualSourcedSingleSlot exists to reject.
  function metaStepDualSource(): AgentPattern {
    return {
      id: 'meta_step_dual',
      kind: 'meta',
      description: 'meta pinning an internal asset AND a caller handle on one single slot',
      tool: {
        description: 'run the meta',
        inputs: z.object({ prompt: z.string().optional() }),
      },
      outputs: IMAGE_OUTPUT,
      compose: async (_params: unknown, ctx: { step: (ref: unknown) => Promise<{ value: unknown }> }) => {
        const { value } = await ctx.step({
          patternId: 'image-gen',
          input: { prompt: 'inner edit', references: { source: 'image_1' } },
          assets: [{ slot: 'source', assetId: 'pinned-internal-src', modality: 'image' }],
        })
        return value
      },
    } as unknown as AgentPattern
  }

  it('resolves sub-step handles against the agent runId ledger, not the session', async () => {
    const bridge = new FakeBridge()
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      script: [
        // 1st dispatch produces image_1 in the AGENT's runId ledger (recordOutput).
        { name: 'dispatch_pattern', input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } }, callId: 'tc-1' },
        // 2nd dispatches the meta whose sub-step forwards that handle.
        { name: 'dispatch_pattern', input: { pattern_id: 'meta_step', input: { prompt: 'go' } }, callId: 'tc-2' },
      ],
    })
    const registry = new PatternRegistry()
    registry.register(imageGen())
    registry.register(metaStep())
    registry.register(agentWithMeta())
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      assetBridge: bridge,
    })

    const job = await rt.submitJob({
      patternId: 'agent_test',
      input: { prompt: 'go' },
      sessionId: 'sess-1',
    })

    // The sub-step resolution consulted the agent's runId ledger — image_1
    // exists ONLY there (sess-1's ledger is empty), so the meta step succeeded.
    const metaResult = capture.results[1] as { code?: string }
    expect(metaResult?.code).toBeUndefined()
    const subStep = bridge.resolveCalls.at(-1)
    expect(subStep?.contextId).toBe(job.id)
    expect(subStep?.contextId).not.toBe('sess-1')
  })

  it('meta sub-step throws DUAL_SOURCE_SINGLE_SLOT when a caller handle and an internal asset target the same single slot', async () => {
    const bridge = new FakeBridge()
    const capture = { results: [] as unknown[] }
    const runImpl = makeRunImpl({
      capture,
      script: [
        // 1st dispatch produces image_1 in the agent runId ledger.
        { name: 'dispatch_pattern', input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } }, callId: 'tc-1' },
        // 2nd dispatches the dual-source meta — its inner step clashes on 'source'.
        { name: 'dispatch_pattern', input: { pattern_id: 'meta_step_dual', input: { prompt: 'go' } }, callId: 'tc-2' },
      ],
    })
    const registry = new PatternRegistry()
    registry.register(imageGen())
    registry.register(metaStepDualSource())
    registry.register({
      ...agentTest(),
      loop: { ...agentTest().loop, toolPatternIds: ['image-gen', 'meta_step_dual'] },
    } as AgentPattern)
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(),
      agentRunImpl: runImpl,
      assetBridge: bridge,
    })

    // The throw happens inside the meta's compose (before any child submit) and
    // propagates as a hard failure — submitJob rejects, unlike a recoverable
    // resolution error which self-corrects into a tool-result. The first dispatch
    // still produced image_1, so the reference genuinely resolved and the guard
    // fired on a real dual-source clash (not a HANDLE_NOT_FOUND miss).
    await expect(
      rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' }, sessionId: 'sess-1' }),
    ).rejects.toThrow(/DUAL_SOURCE_SINGLE_SLOT: slot "source"/)
  })
})

// Step visibility — each step-end with in-flight tool calls fans out a
// job:progress naming them, so the host task strip shows what a long-running
// agent is doing instead of a bare spinner.
describe('agent step visibility', () => {
  it('fans out job:progress naming the in-flight tools on step end', async () => {
    const runImpl: AgentRunImpl = {
      async run(args) {
        args.onStepFinish?.({
          stepIndex: 0,
          toolCalls: [{ name: 'image-gen' }],
          text: '',
        })
        await args.onToolCall({
          name: args.finishToolName,
          input: { summary: 'done', deliverables: [] },
          callId: 'finish',
        })
        return { text: 'done' }
      },
    }
    const rt = buildRuntime({ pattern: agentTest(), runImpl, bridge: new FakeBridge() })
    // subscribe(jobId) can't be registered before the run emits — capture at
    // the private fanout seam instead (fanoutJobEvent → fanout).
    const fanout = vi.spyOn(
      rt as unknown as { fanout: (id: string, ev: unknown) => void },
      'fanout',
    )
    await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    await vi.waitFor(() => {
      const progress = fanout.mock.calls
        .map(([, ev]) => ev as { type: string; message?: string })
        .find((e) => e.type === 'job:progress')
      expect(progress?.message).toBe('step 1 · image-gen')
    })
  })
})
