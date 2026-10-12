// dispatchAgent ⋈ AgentAssetBridge wiring.
// Builds a real InlineRuntime over an in-memory JobStore + a scripted fake
// AgentRunImpl (stands in for the worker LLM) + a fake AgentAssetBridge
// (stands in for the host's asset ledger) so we can assert seed announcement,
// asset-free SystemPromptContext, inner resolve/record, and that partial
// results flow back on failure.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AssetKind,
  AssetNeed,
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
  buildAssetIndex,
  deriveNamedHandles,
  silentDiagnosticsLogger,
  mintHandle,
  PatternRegistry,
  productNameOf,
  resolveAssetReferences,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

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
        // No `references` here: registration derives it from SRC_NEED, and a
        // hand-written one is refused (INPUT_RESERVED_KEY).
        inputs: z.object({ prompt: z.string().optional() }),
      },
    },
  } as unknown as AtomicPattern
}

// A producer with no asset slots — the `text-to-audio` shape. Registration
// still gives it `name` (its outputs carry assets[]), but no `references`.
function imageGenNoSlots(): AtomicPattern {
  return {
    id: 'image-gen-plain',
    kind: 'atomic',
    description: 'generate an image from text alone',
    exposure: 'agent-tool',
    outputs: IMAGE_OUTPUT,
    primary: {
      tool: {
        description: 'make an image from a prompt',
        inputs: z.object({ prompt: z.string().optional() }),
      },
    },
  } as unknown as AtomicPattern
}

// image-gen laid out as a direct tool of the loop (inline core), so a call
// arrives by tool name rather than through dispatch_pattern.
function imageGenInline(): AtomicPattern {
  return {
    ...imageGen(),
    id: 'image-gen-inline',
    exposure: 'agent-tool',
    exposureMode: 'always-load',
  } as unknown as AtomicPattern
}

// A Pattern whose outputs carry no assets[]: registration gives it no `name`.
function textGen(): AtomicPattern {
  return {
    id: 'text-gen',
    kind: 'atomic',
    description: 'write a short caption',
    exposure: 'agent-tool',
    outputs: z.object({ text: z.string().max(100) }),
    primary: {
      tool: {
        description: 'write a caption',
        inputs: z.object({ prompt: z.string().optional() }),
      },
    },
  } as unknown as AtomicPattern
}

function agentTest(
  systemSpy?: (input: unknown, ctx: SystemPromptContext) => string,
  opts?: { inheritParentAssets?: boolean; toolPatternIds?: readonly string[] },
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
      toolPatternIds: opts?.toolPatternIds ?? ['image-gen'],
      modelTags: [],
      ...(opts?.inheritParentAssets ? { inheritParentAssets: true } : {}),
    },
  } as unknown as AgentPattern
}

// ── Fake AgentAssetBridge — Map<contextId, ledger entries> + real mintHandle.
//    resolveForDispatch is core's resolution pass over that ledger, thrown
//    on failure (fail-closed). ──────────────────────────────────────────────
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
  // The raw args of every call, exactly as the runtime passed them.
  readonly resolveArgs: Array<Parameters<AgentAssetBridge['resolveForDispatch']>[0]> = []
  readonly recordArgs: Array<Parameters<AgentAssetBridge['recordOutput']>[0]> = []

  private ledger(contextId: string): LedgerEntry[] {
    let l = this.ledgers.get(contextId)
    if (!l) {
      l = []
      this.ledgers.set(contextId, l)
    }
    return l
  }

  /**
   * The context's ledger as core indexes it: every row replayed under the
   * handle it was recorded with, less the rows of any assetId in `without`.
   */
  private indexOf(contextId: string, without: ReadonlySet<string> = new Set()) {
    return buildAssetIndex(
      this.ledger(contextId)
        .filter((e) => !without.has(e.assetId))
        .map((e, i) => ({
          kind: 'asset' as const,
          orderHint: i,
          annotation: { assetId: e.assetId, modality: e.modality, handle: e.handle },
        })),
    )
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
    this.resolveArgs.push(args)
    this.resolveCalls.push({ contextId: args.contextId, input: args.input })
    // Core's own pass, not a copy of it, so the fake refuses exactly what a
    // real bridge would: a taken name (and its `<name>-<n>` family) before any
    // slot, then undeclared slot keys, then each handle.
    const result = resolveAssetReferences(
      args.input as Parameters<typeof resolveAssetReferences>[0],
      args.assetNeeds,
      this.indexOf(args.contextId),
    )
    if (!result.ok) throw new AssetResolutionError(result.error)
    const out = [...result.assets]
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
    name?: string
  }): unknown {
    this.recordArgs.push(args)
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
    // A named dispatch's products take the name (several: <name>-1 …); an
    // unnamed one's are minted. The host obligation recordOutput's JSDoc
    // states: just before writing, ask core again whether the context holds
    // the name — a same-turn call may have taken it since resolveForDispatch
    // cleared it — leaving out the assets this call is recording, whose own
    // earlier record (a retry, a dedupe hit) holds the name by right. Taken,
    // every product of this call is minted, and the result says so at the top
    // level, where the projection keeps it.
    let named = args.name !== undefined ? deriveNamedHandles(args.name, assets.length) : undefined
    let takenBy: string | undefined
    if (args.name !== undefined) {
      const own = new Set(assets.map((a) => a.assetId))
      const recheck = resolveAssetReferences({ name: args.name }, [], this.indexOf(args.contextId, own))
      if (!recheck.ok && recheck.error.code === 'HANDLE_TAKEN') {
        named = undefined
        takenBy = recheck.error.meta.boundTo.handle
      }
    }
    for (const [i, a] of assets.entries()) {
      const prior = l.filter((e) => e.modality === a.modality).length
      const handle = named?.[i] ?? mintHandle(a.modality, prior)
      // The same asset under the same handle is a replay, as a store treats it:
      // nothing new to write.
      if (!l.some((e) => e.handle === handle && e.assetId === a.assetId)) {
        l.push({ assetId: a.assetId, modality: a.modality, handle })
      }
      // Mirror the host bridge: stamp the minted handle + origin onto the
      // model-facing output so the downstream projection keeps the asset.
      stampedAssets.push({ ...a, handle, origin: 'generated' })
    }
    if (assets.length === 0) return args.output
    const notice =
      takenBy === undefined
        ? {}
        : {
            notice: `The name "${args.name}" was taken in this context (by ${takenBy}) before these products were recorded, so they keep generated handles: ${stampedAssets.map((a) => a.handle).join(', ')}.`,
          }
    return { ...(args.output as Record<string, unknown>), ...notice, assets: stampedAssets }
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

  handlesFor(args: { contextId: string; assetIds: readonly string[] }): readonly string[] {
    const l = this.ledger(args.contextId)
    // Only what this context can name. An id from a child agent's own ledger
    // is simply absent — the caller reports that as a count.
    return args.assetIds
      .map((assetId) => l.find((e) => e.assetId === assetId)?.handle)
      .filter((h): h is string => h !== undefined)
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

// `store` lets a test read the rows the run wrote; one is made when omitted.
function buildRuntime(opts: {
  pattern: AgentPattern
  runImpl: AgentRunImpl
  bridge?: AgentAssetBridge
  store?: MemoryJobStore
}): InlineRuntime {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(imageGen())
  registry.register(imageGenNoSlots())
  registry.register(imageGenInline())
  registry.register(textGen())
  registry.register(opts.pattern)
  return new InlineRuntime({
    store: (opts.store ?? new MemoryJobStore()) as never,
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
      { slot: 'source', assetId: 'gen-asset', modality: 'image', handle: 'image_1' },
    ])
    // Both children succeeded (tool-results are the typed image outputs).
    expect(capture.results.length).toBe(2)
    // Ledger now holds the produced asset under its minted handle.
    const contextLedger = [...bridge.ledgers.values()][0]
    expect(contextLedger.some((e) => e.assetId === 'gen-asset' && e.handle === 'image_1')).toBe(true)
  })

  it('stamps the recorded handle (+ origin/from) onto the tool-result returned to the loop', async () => {
    // The agent path must forward recordOutput's
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
    // The bridge raises UNKNOWN_SLOT itself: a strict derived `references` now refuses an undeclared key at parse (core's dispatch tests cover that path).
    vi.spyOn(bridge, 'resolveForDispatch').mockImplementation(() => {
      throw new AssetResolutionError({
        code: 'UNKNOWN_SLOT',
        slot: 'bad_slot',
        meta: { declaredSlots: ['source'], available: [] },
      })
    })
    const runImpl = makeRunImpl({
      capture,
      script: [
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'edit', references: { source: 'image_1' } } },
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

  it('whole-agent failure attaches producedAssets to the failed Job\'s error', async () => {
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
    // The failure lands on the resolved Job — submitJob settles with the
    // errored row rather than rethrowing the dispatch error.
    let failedJob: Job | undefined
    const settled = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(settled.status).toBe('error')
    expect(settled.error?.message).toContain('boom')
    expect(settled.error?.producedAssets).toEqual(['gen-asset'])
    // And the job landed in error.
    const all = await (rt as unknown as { store: MemoryJobStore }).store.query()
    failedJob = all.find((j) => j.patternId === 'agent_test')
    expect(failedJob?.status).toBe('error')
    const err = failedJob?.error as JobError | null
    expect(err).not.toBeNull()
    // normaliseError preserves producedAssets off the thrown error
    // onto the STORED JobError. This is the observable carrier the parent
    // (chat.ts JOB_FAILED / inline SUBAGENT_TOOL_FAILED) reads to surface
    // partial output in its failure tool-result.
    expect(err?.producedAssets).toEqual(['gen-asset'])
  })

  it('SUBAGENT_TOOL_FAILED reports a produced-asset COUNT when this context cannot name them (cached-error path)', async () => {
    // An agent dispatches `image-gen` as a tool. The child dispatch resolves
    // via the idempotency cache to an errored job whose JobError carries
    // producedAssets (the salvage carrier). The cached path returns
    // child.status === 'error' (NOT a fresh throw), so inline.ts onToolCall
    // builds SUBAGENT_TOOL_FAILED — which must translate the child's
    // producedAssets into this context's handles, or report a bare count.
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

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
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
    const result = capture.results[0] as {
      code?: string
      produced_assets?: unknown
      produced_handles?: unknown
      produced_count?: number
    }
    expect(result.code).toBe('SUBAGENT_TOOL_FAILED')
    // The child's partial work lives in ITS ledger, which this agent's context
    // cannot name — so the loop is told there is one asset it cannot address,
    // and is told nothing it could not use. The raw id stays on the child's
    // JobError, where the host reads it.
    expect(result.produced_count).toBe(1)
    expect(result.produced_handles).toBeUndefined()
    expect(result.produced_assets).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('partial-asset')
  })

  it('SUBAGENT_TOOL_FAILED names partial work in handles when this context can resolve them', async () => {
    // The first dispatch succeeds and the bridge records `gen-asset` into this
    // agent's context as `image_1`. The second fails carrying that same id as
    // partial work. The loop's asset language is handles, so the tool-result
    // says `image_1` — a name it can put straight into a `references` slot —
    // and the id it could neither cite nor resolve never reaches the wire.
    const capture = { results: [] as unknown[] }
    let calls = 0
    const cap = {
      modelId: 'fake:img',
      provider: 'fake',
      tags: [] as never[],
      capabilities: ['image-gen'] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['image'] as Modality[],
      source: 'user' as const,
      async call() {
        calls++
        if (calls === 1) {
          return {
            output: {
              modality: 'image',
              assets: [{ assetId: 'gen-asset', modality: 'image' }],
            },
          }
        }
        // A fresh throw (not the cached-error path) carrying partial work, the
        // way a sub-agent's whole-run failure does.
        throw Object.assign(new Error('gave up after one draft'), {
          code: 'IMAGE_GEN_FAILED',
          producedAssets: ['gen-asset'],
        })
      },
    } as unknown as ModelCapability
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(imageGen())
    registry.register(agentTest())
    const runImpl = makeRunImpl({
      capture,
      script: [
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'a cat' } },
          callId: 'tc-1',
        },
        {
          name: 'dispatch_pattern',
          input: { pattern_id: 'image-gen', input: { prompt: 'now a dog' } },
          callId: 'tc-2',
        },
      ],
    })
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: {
        checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
        resolve: () => cap,
      },
      agentRunImpl: runImpl,
      assetBridge: bridge,
    })

    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })

    expect(job.status).toBe('done')
    const failure = capture.results[1] as {
      code?: string
      produced_handles?: readonly string[]
      produced_count?: number
      produced_assets?: unknown
    }
    expect(failure.code).toBe('SUBAGENT_TOOL_FAILED')
    expect(failure.produced_handles).toEqual(['image_1'])
    expect(failure.produced_count).toBe(1)
    expect(failure.produced_assets).toBeUndefined()
    // The same assertion the success path's projection is held to: no assetId
    // anywhere on the wire the model reads.
    expect(JSON.stringify(failure)).not.toContain('gen-asset')
    // The host-facing carrier is untouched — the child row still has the id.
    const rows = await (rt as unknown as { store: MemoryJobStore }).store.query()
    const child = rows.find((r) => r.patternId === 'image-gen' && r.status === 'error')
    expect(child?.error?.producedAssets).toEqual(['gen-asset'])
  })
})

// A dispatch input's `name` is the handle its product is recorded under. The
// runtime reads it once (productNameOf), asks the bridge whether the context
// already holds it — for every named call, slots or none — and hands the
// normalised name to recordOutput. Everything else about it (the grammar, the
// refusal on a Pattern that records nothing) is core's parse, and is pinned
// here only as "the bridge never hears of it".
describe('model-named handles', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = new FakeBridge()
  })

  function dispatch(patternId: string, input: Record<string, unknown>, callId: string): ToolStep {
    return { name: 'dispatch_pattern', input: { pattern_id: patternId, input }, callId }
  }

  async function runAgent(
    script: ToolStep[],
    opts: { toolPatternIds?: readonly string[]; store?: MemoryJobStore } = {},
  ): Promise<unknown[]> {
    const capture = { results: [] as unknown[] }
    const rt = buildRuntime({
      pattern: agentTest(undefined, opts.toolPatternIds ? { toolPatternIds: opts.toolPatternIds } : {}),
      runImpl: makeRunImpl({ capture, script }),
      bridge,
      ...(opts.store ? { store: opts.store } : {}),
    })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    return capture.results
  }

  type ModelFacingAssets = { assets?: Array<{ handle?: string; uri?: string }> }
  type ToolFailure = {
    code?: string
    error?: { code?: string; handle?: string; meta?: { boundTo?: { handle?: string } } }
    issues?: Array<{ code?: string; path?: unknown[] }>
    hint?: string
  }

  it('forwards the normalised name to recordOutput, and the product is addressed by it', async () => {
    const results = await runAgent([dispatch('image-gen', { prompt: 'a hero shot', name: ' asset://hero ' }, 'tc-1')])

    expect(bridge.recordArgs).toHaveLength(1)
    expect(bridge.recordArgs[0]?.name).toBe('hero')
    const result = results[0] as ModelFacingAssets
    expect(result.assets?.[0]?.handle).toBe('hero')
    expect(result.assets?.[0]?.uri).toBe('asset://hero')
    // The input reaches the bridge as written: normalising is the reader's
    // job (productNameOf), never a rewrite of what was dispatched.
    expect((bridge.resolveArgs[0]?.input as { name?: unknown }).name).toBe(' asset://hero ')
  })

  it('an inline always-load call names its product the same way', async () => {
    const results = await runAgent(
      [{ name: 'image-gen-inline', input: { prompt: 'a cover', name: 'cover' }, callId: 'tc-1' }],
      { toolPatternIds: ['image-gen-inline'] },
    )

    expect(bridge.recordArgs).toHaveLength(1)
    expect(bridge.recordArgs[0]?.patternId).toBe('image-gen-inline')
    expect(bridge.recordArgs[0]?.name).toBe('cover')
    expect((results[0] as ModelFacingAssets).assets?.[0]?.handle).toBe('cover')
  })

  it('an unnamed dispatch passes no name key to recordOutput, and a blank name counts as unnamed', async () => {
    const results = await runAgent([
      dispatch('image-gen', { prompt: 'a cat' }, 'tc-1'),
      dispatch('image-gen', { prompt: 'a dog', name: '   ' }, 'tc-2'),
    ])

    expect(bridge.recordArgs).toHaveLength(2)
    expect('name' in bridge.recordArgs[0]!).toBe(false)
    expect('name' in bridge.recordArgs[1]!).toBe(false)
    // Both products are minted, as they were before names existed.
    expect(results.map((r) => (r as ModelFacingAssets).assets?.[0]?.handle)).toEqual(['image_1', 'image_2'])
  })

  it('a named dispatch is checked by resolveForDispatch even when the Pattern declares no asset slots', async () => {
    const results = await runAgent(
      [
        dispatch('image-gen-plain', { prompt: 'unnamed' }, 'tc-1'),
        dispatch('image-gen-plain', { prompt: 'first plate', name: 'plate' }, 'tc-2'),
        dispatch('image-gen-plain', { prompt: 'second plate', name: 'plate' }, 'tc-3'),
      ],
      { toolPatternIds: ['image-gen-plain'] },
    )

    // Only the two named calls reached the bridge: an unnamed call to a
    // slotless Pattern still makes no resolveForDispatch call.
    expect(bridge.resolveArgs.map((a) => productNameOf(a.input))).toEqual(['plate', 'plate'])
    expect(bridge.resolveArgs.every((a) => a.assetNeeds.length === 0)).toBe(true)
    expect((results[1] as ModelFacingAssets).assets?.[0]?.handle).toBe('plate')
    // And the check is real: the second `plate` is refused, not recorded.
    const refused = results[2] as ToolFailure
    expect(refused.code).toBe('ASSET_RESOLUTION_FAILED')
    expect(refused.error?.code).toBe('HANDLE_TAKEN')
    expect(bridge.recordArgs).toHaveLength(2)
  })

  it('a name the context already holds comes back as ASSET_RESOLUTION_FAILED with the HANDLE_TAKEN hint, and nothing is dispatched', async () => {
    const store = new MemoryJobStore()
    // Different prompts, so a second dispatch would be a second row rather
    // than a dedupe hit on the first.
    const results = await runAgent(
      [
        dispatch('image-gen', { prompt: 'a hero shot', name: 'hero' }, 'tc-1'),
        dispatch('image-gen', { prompt: 'another hero shot', name: 'hero' }, 'tc-2'),
      ],
      { store },
    )

    const refused = results[1] as ToolFailure
    expect(refused.code).toBe('ASSET_RESOLUTION_FAILED')
    expect(refused.error?.code).toBe('HANDLE_TAKEN')
    expect(refused.error?.handle).toBe('hero')
    expect(refused.error?.meta?.boundTo?.handle).toBe('hero')
    expect(refused.hint).toContain('different name')
    expect(refused.hint).toBe(
      'That name is already in use in this context (error.meta.boundTo holds it). Reference that asset if it is the one you meant; otherwise dispatch again with a different name, or without one.',
    )
    expect(bridge.recordArgs).toHaveLength(1)
    expect(await store.query({ patternId: 'image-gen' })).toHaveLength(1)
  })

  it('a name in the mint grammar is refused with INPUT_VALIDATION_FAILED at path name, before any bridge call', async () => {
    const results = await runAgent([dispatch('image-gen', { prompt: 'a cat', name: 'image_3' }, 'tc-1')])

    const refused = results[0] as ToolFailure
    expect(refused.code).toBe('INPUT_VALIDATION_FAILED')
    expect(refused.issues).toHaveLength(1)
    expect(refused.issues?.[0]?.path).toEqual(['name'])
    expect(bridge.resolveArgs).toHaveLength(0)
    expect(bridge.recordArgs).toHaveLength(0)
  })

  it('a name on a Pattern that produces no assets is refused before any bridge call', async () => {
    const store = new MemoryJobStore()
    const results = await runAgent([dispatch('text-gen', { prompt: 'a caption', name: 'caption' }, 'tc-1')], {
      toolPatternIds: ['text-gen'],
      store,
    })

    const refused = results[0] as ToolFailure
    expect(refused.code).toBe('INPUT_VALIDATION_FAILED')
    expect(refused.issues).toHaveLength(1)
    expect(refused.issues?.[0]).toMatchObject({ code: 'custom', path: ['name'] })
    expect(bridge.resolveArgs).toHaveLength(0)
    expect(bridge.recordArgs).toHaveLength(0)
    expect(await store.query({ patternId: 'text-gen' })).toHaveLength(0)
  })

  // Two named dispatches in one turn, both cleared by resolveForDispatch before
  // either records: the first dispatch's model call is held until both have
  // resolved, any other until the first record. Only the check the bridge runs
  // again just before its write can then see what the other call recorded.
  async function sameTurn(
    steps: readonly [ToolStep, ToolStep],
    assetsFor: (prompt: string | undefined) => Array<{ assetId: string; modality: 'image' }>,
    store: MemoryJobStore = new MemoryJobStore(),
  ): Promise<{ gated: FakeBridge; job: Job; results: Array<ModelFacingAssets & { notice?: string }> }> {
    let bothResolved!: () => void
    const resolvedGate = new Promise<void>((resolve) => (bothResolved = resolve))
    let firstRecorded!: () => void
    const recordedGate = new Promise<void>((resolve) => (firstRecorded = resolve))
    class GatedBridge extends FakeBridge {
      override resolveForDispatch(args: Parameters<FakeBridge['resolveForDispatch']>[0]) {
        const out = super.resolveForDispatch(args)
        if (this.resolveArgs.length === 2) bothResolved()
        return out
      }
      override recordOutput(args: Parameters<FakeBridge['recordOutput']>[0]) {
        const out = super.recordOutput(args)
        firstRecorded()
        return out
      }
    }
    const gated = new GatedBridge()
    const firstPrompt = (steps[0].input as { input: { prompt?: string } }).input.prompt
    const cap = {
      modelId: 'fake:img',
      provider: 'fake',
      tags: [] as never[],
      capabilities: ['image-gen'] as never[],
      inputs: ['text'] as Modality[],
      outputs: ['image'] as Modality[],
      source: 'user' as const,
      async call(input: { prompt?: string }) {
        await (input.prompt === firstPrompt ? resolvedGate : recordedGate)
        return { output: { modality: 'image', assets: assetsFor(input.prompt) } }
      },
    } as unknown as ModelCapability
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(imageGen())
    registry.register(agentTest())
    const results: unknown[] = []
    const rt = new InlineRuntime({
      store: store as never,
      registry,
      router: { checkSatisfiable: () => ({ ok: true, candidates: [cap] }), resolve: () => cap },
      agentRunImpl: {
        async run(args) {
          results.push(...(await Promise.all(steps.map((step) => args.onToolCall(step)))))
          await args.onToolCall({
            name: args.finishToolName,
            input: { summary: 'done', deliverables: [] },
            callId: 'finish',
          })
          return { text: 'done' }
        },
      },
      assetBridge: gated,
    })
    const job = await rt.submitJob({ patternId: 'agent_test', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    expect(gated.resolveArgs.map((a) => productNameOf(a.input))).toEqual(['hero', 'hero'])
    return { gated, job, results: results as Array<ModelFacingAssets & { notice?: string }> }
  }

  it('two same-turn calls with one name: the later writer finds it taken, mints every product and says so', async () => {
    // Without the check before the write the pair would be written as hero-1,
    // hero-2 beside hero: one name on two products, and no handle bound twice
    // for a store to refuse.
    const { gated, job, results } = await sameTurn(
      [
        dispatch('image-gen', { prompt: 'one hero', name: 'hero' }, 'tc-1'),
        dispatch('image-gen', { prompt: 'two heroes', name: 'hero' }, 'tc-2'),
      ],
      (prompt) =>
        prompt === 'one hero'
          ? [{ assetId: 'single-0', modality: 'image' }]
          : [
              { assetId: 'pair-0', modality: 'image' },
              { assetId: 'pair-1', modality: 'image' },
            ],
    )

    expect(gated.recordArgs.map((a) => a.name)).toEqual(['hero', 'hero'])
    expect(gated.ledgers.get(job.id)!.map((e) => [e.handle, e.assetId])).toEqual([
      ['hero', 'single-0'],
      ['image_2', 'pair-0'],
      ['image_3', 'pair-1'],
    ])
    const [single, pair] = results
    expect(single?.assets?.map((a) => a.handle)).toEqual(['hero'])
    expect(single?.notice).toBeUndefined()
    expect(pair?.assets?.map((a) => a.handle)).toEqual(['image_2', 'image_3'])
    expect(pair?.notice).toBe(
      'The name "hero" was taken in this context (by hero) before these products were recorded, so they keep generated handles: image_2, image_3.',
    )
  })

  it('a same-turn duplicate of a named call records the same products under the name, with no notice', async () => {
    // The second call is the first one again, and dedupe-hits the first row
    // once it is done — its insert is held until then, because a hit on a row
    // still in flight hands back a null output. So the same products are
    // recorded twice under one name. They already hold it: the check before
    // the write leaves out the assets the call is recording, since a replay of
    // a call's own products is not a clash, and minting them would split what
    // the name refers to.
    let firstId: string | undefined
    let firstDone!: () => void
    const doneGate = new Promise<void>((resolve) => (firstDone = resolve))
    class AfterFirstDoneStore extends MemoryJobStore {
      override async insertIfAbsent(job: Job): Promise<Job> {
        if (job.patternId === 'image-gen') {
          if (firstId === undefined) firstId = job.id
          else await doneGate
        }
        return super.insertIfAbsent(job)
      }
      override async update(id: string, patch: Partial<Job>): Promise<void> {
        await super.update(id, patch)
        if (id === firstId && patch.status === 'done') firstDone()
      }
    }
    const store = new AfterFirstDoneStore()
    const step = (callId: string) => dispatch('image-gen', { prompt: 'one hero', name: 'hero' }, callId)
    const { gated, job, results } = await sameTurn(
      [step('tc-1'), step('tc-2')],
      () => [{ assetId: 'single-0', modality: 'image' }],
      store,
    )

    expect(await store.query({ patternId: 'image-gen' })).toHaveLength(1)
    expect(gated.recordArgs.map((a) => a.name)).toEqual(['hero', 'hero'])
    expect(gated.ledgers.get(job.id)!.map((e) => [e.handle, e.assetId])).toEqual([['hero', 'single-0']])
    for (const result of results) {
      expect(result.assets?.map((a) => a.handle)).toEqual(['hero'])
      expect(result.notice).toBeUndefined()
    }
  })

  it('a product name is part of the work: the same prompt under two names is two jobs', async () => {
    const store = new MemoryJobStore()
    await runAgent(
      [
        // The control: unnamed, the same prompt twice is one job.
        dispatch('image-gen', { prompt: 'a cat' }, 'tc-1'),
        dispatch('image-gen', { prompt: 'a cat' }, 'tc-2'),
        dispatch('image-gen', { prompt: 'a cat', name: 'cat-left' }, 'tc-3'),
        dispatch('image-gen', { prompt: 'a cat', name: 'cat-right' }, 'tc-4'),
      ],
      { store },
    )

    const rows = await store.query({ patternId: 'image-gen' })
    expect(rows).toHaveLength(3)
    const names = rows.map((r) => (r.input as { name?: unknown }).name)
    expect(names).toHaveLength(3)
    expect(names).toEqual(expect.arrayContaining([undefined, 'cat-left', 'cat-right']))
    expect(bridge.recordArgs.map((a) => a.name)).toEqual([undefined, undefined, 'cat-left', 'cat-right'])
  })
})

// An agent-dispatched meta resolves its SUB-STEP references against the
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
      // `ctx.step` resolves to the child's VALUE (`.withMeta()` is the
      // `{ value, meta }` form), so the step's output is returned as-is and
      // conforms to the meta's declared IMAGE_OUTPUT. Destructuring a `value`
      // off it returned undefined and failed the dispatch-exit output gate —
      // invisible while a failed child dispatch rejected out of the loop, and
      // named as SUBAGENT_TOOL_FAILED the moment it became a tool result.
      compose: async (_params: unknown, ctx: { step: (ref: unknown) => Promise<unknown> }) =>
        await ctx.step({
          patternId: 'image-gen',
          input: { prompt: 'inner edit', references: { source: 'image_1' } },
        }),
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
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
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

  it('meta sub-step DUAL_SOURCE_SINGLE_SLOT reaches the loop as SUBAGENT_TOOL_FAILED', async () => {
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
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
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
    // unwinds the meta's own job — but it reaches the AGENT as a tool result,
    // not as a rejection: a failed child dispatch is data the loop reads and
    // acts on (docs/plan.md, "Open decisions — 4"), so the agent job settles
    // `done` and the guard's own code rides in `inner_code`. The first dispatch
    // still produced image_1, so the reference genuinely resolved and the guard
    // fired on a real dual-source clash (not a HANDLE_NOT_FOUND miss).
    const job = await rt.submitJob({
      patternId: 'agent_test', input: { prompt: 'go' }, sessionId: 'sess-1',
    })
    expect(job.status).toBe('done')
    const metaResult = capture.results[1] as { code?: string; inner_code?: string; message?: string }
    expect(metaResult.code).toBe('SUBAGENT_TOOL_FAILED')
    expect(metaResult.inner_code).toBe('DUAL_SOURCE_SINGLE_SLOT')
    expect(metaResult.message).toMatch(/DUAL_SOURCE_SINGLE_SLOT: slot "source"/)
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
