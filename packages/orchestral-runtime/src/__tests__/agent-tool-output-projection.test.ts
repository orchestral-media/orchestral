// Model-facing projection at the agent-dispatch tool-result boundary.
//
// dispatchAgent owns the model call for its loop, so it owns the projection:
// every dispatch_pattern tool-result is run through
// `sanitizeToolOutput(projectToolOutputForModel(…))` before it reaches the
// loop — on BOTH paths, bridge present (stamped) and bridge absent (raw
// child.output). Locks the no-assetId invariant at the runtime's own seam;
// previously only @orchestral/dsh-plugin applied it, and a host that did not
// inject an AgentAssetBridge fed real assetIds + signed URLs straight into
// the model.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AgentPattern,
  AssetKind,
  AtomicPattern,
  CapabilityRouter,
  ModelCapability,
  Modality,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  InMemoryJobStore as MemoryJobStore,
  InMemoryTranscriptStore,
  mintHandle,
  PatternRegistry,
} from '@orchestral/core'

import { InlineRuntime, type AgentAssetBridge } from '../inline'
import type { AgentRunImpl } from '../agent-run'

const SIGNED_URL = 'https://signed.example/x?token=abc123XYZ'
const REAL_ASSET_ID = 'real-123'
// The exact marker sanitize.ts substitutes for any string starting with `data:`.
const STRIPPED_MARKER = '<binary stripped — reference via assetId>'

// Router whose single capability echoes `output` as the child's raw output.
// The runtime does not parse atomic outputs against pattern.outputs, so
// whatever this returns is exactly what arrives at the return site.
function makeRouter(output: unknown): CapabilityRouter {
  const cap = {
    modelId: 'fake:child',
    provider: 'fake',
    tags: [] as never[],
    capabilities: ['image-gen'] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['image'] as Modality[],
    source: 'user' as const,
    async call() {
      return { output }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

function childPattern(): AtomicPattern {
  return {
    id: 'child-gen',
    kind: 'atomic',
    description: 'child whose raw output the test controls',
    exposure: 'agent-tool',
    outputs: z.looseObject({}),
    primary: {
      tool: {
        description: 'run the child',
        inputs: z.object({ prompt: z.string().optional() }),
      },
    },
  } as unknown as AtomicPattern
}

function agentPattern(): AgentPattern {
  return {
    id: 'agent_projection',
    kind: 'agent',
    description: 'agent that dispatches child-gen once',
    primary: { tool: { description: 'run', inputs: z.object({ prompt: z.string() }) } },
    loop: { system: 'sys', toolPatternIds: ['child-gen'], modelTags: [] },
  } as unknown as AgentPattern
}

// Drives one dispatch_pattern call, captures the tool-result the loop saw,
// then finishes cleanly via the injected finish tool.
function makeRunImpl(capture: { result?: unknown }): AgentRunImpl {
  return {
    async run(args) {
      capture.result = await args.onToolCall({
        name: 'dispatch_pattern',
        input: { pattern_id: 'child-gen', input: { prompt: 'go' } },
        callId: 'tc-1',
      })
      await args.onToolCall({
        name: args.finishToolName,
        input: { summary: 'done', deliverables: [] },
        callId: 'finish',
      })
      return { text: 'done' }
    },
  }
}

// Minimal bridge mirroring the host contract for recordOutput: stamp a
// minted handle + origin + from-lineage onto each produced asset, leaving the
// raw assetId/url in place — the projection, not the bridge, removes those.
function makeStampingBridge(seen: { stamped?: unknown }): AgentAssetBridge {
  const ledger: Array<{ assetId: string; modality: AssetKind; handle: string }> = []
  return {
    buildSeedAnnouncement: () => null,
    resolveForDispatch: () => [],
    resolveHandles: () => [],
    recordedAssetIds: () => ledger.map((e) => e.assetId),
    recordOutput: ({ output }) => {
      const rec = output as { assets?: Array<{ assetId: string; modality: AssetKind }> }
      const assets = (rec.assets ?? []).map((a) => {
        const prior = ledger.filter((e) => e.modality === a.modality).length
        const handle = mintHandle(a.modality, prior)
        ledger.push({ assetId: a.assetId, modality: a.modality, handle })
        return {
          ...a,
          handle,
          origin: 'generated' as const,
          // A dirty from-entry: the projection must keep only {handle, role}.
          from: [{ handle: 'image_0', role: 'source', assetId: 'leaked-input-id' }],
        }
      })
      const stamped = { ...(output as Record<string, unknown>), assets }
      seen.stamped = stamped
      return stamped
    },
  }
}

async function runAgent(opts: { childOutput: unknown; bridge?: AgentAssetBridge }): Promise<unknown> {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(childPattern())
  registry.register(agentPattern())
  const capture: { result?: unknown } = {}
  const rt = new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry,
    router: makeRouter(opts.childOutput),
    agentRunImpl: makeRunImpl(capture),
    ...(opts.bridge ? { assetBridge: opts.bridge } : {}),
  })
  const job = await rt.submitJob({ patternId: 'agent_projection', input: { prompt: 'go' } })
  expect(job.status).toBe('done')
  return capture.result
}

// Recursively collects every object key and every string value in a tool-result.
function walk(value: unknown, keys: Set<string>, strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, keys, strings)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys.add(k)
      walk(v, keys, strings)
    }
  }
}

function expectNoLeak(result: unknown): void {
  const keys = new Set<string>()
  const strings: string[] = []
  walk(result, keys, strings)
  expect(keys.has('assetId')).toBe(false)
  expect(keys.has('url')).toBe(false)
  for (const s of strings) {
    expect(s).not.toContain(REAL_ASSET_ID)
    expect(s).not.toContain('signed.example')
    expect(s).not.toContain('token=')
  }
}

const RAW_MEDIA_OUTPUT = {
  modality: 'image',
  // Legacy top-level singular — the projection physically deletes it.
  assetId: REAL_ASSET_ID,
  assets: [{ assetId: REAL_ASSET_ID, modality: 'image', url: SIGNED_URL }],
  cost: 0.01,
}

describe('dispatchAgent tool-result projection', () => {
  it('no bridge: the raw child output is projected — no assetId key and no signed URL reach the loop', async () => {
    const result = await runAgent({ childOutput: RAW_MEDIA_OUTPUT })
    expectNoLeak(result)
    // The projected shape: non-asset top-level fields pass through, the legacy
    // top-level assetId is deleted, and the element is dropped from assets[]
    // because it carries no handle (no bridge minted one). The loop sees an
    // empty inventory rather than a real id it could never resolve anyway.
    expect(result).toEqual({ modality: 'image', cost: 0.01, assets: [] })
  })

  it('bridge present: the stamped output is projected and the minted handle survives', async () => {
    const seen: { stamped?: unknown } = {}
    const result = await runAgent({ childOutput: RAW_MEDIA_OUTPUT, bridge: makeStampingBridge(seen) })
    // The bridge really did hand back assetId + url alongside the handle — so
    // the projection at the return site is what removed them.
    const stampedAsset = (seen.stamped as { assets: Array<Record<string, unknown>> }).assets[0]
    expect(stampedAsset.assetId).toBe(REAL_ASSET_ID)
    expect(stampedAsset.url).toBe(SIGNED_URL)
    expect(stampedAsset.handle).toBe('image_1')
    expectNoLeak(result)
    expect(result).toEqual({
      modality: 'image',
      cost: 0.01,
      assets: [
        {
          handle: 'image_1',
          uri: 'asset://image_1',
          modality: 'image',
          origin: 'generated',
          // from-lineage re-shaped to {handle, role}: the stray assetId is gone.
          from: [{ handle: 'image_0', role: 'source' }],
        },
      ],
    })
  })

  it('a data: URI anywhere in the output is replaced by the sanitizer marker', async () => {
    const result = await runAgent({
      childOutput: {
        text: 'caption',
        preview: 'data:image/png;base64,iVBORw0KGgo=',
        nested: { thumbs: ['data:image/jpeg;base64,/9j/4AAQ', 'https://cdn.example/thumb.jpg'] },
      },
    })
    expect(result).toEqual({
      text: 'caption',
      preview: STRIPPED_MARKER,
      nested: { thumbs: [STRIPPED_MARKER, 'https://cdn.example/thumb.jpg'] },
    })
  })

  it('a text-only output (no assets[]) passes through unchanged apart from sanitization', async () => {
    const childOutput = { text: 'hello world', tokens: 3, tags: ['a', 'b'] }
    const result = await runAgent({ childOutput })
    expect(result).toEqual(childOutput)
  })
})

// The transcript is replayed verbatim into model context on resume
// (`transcriptMessageToChat` hands a 'tool-result' back as a `tool` turn), so
// it is a second model-facing boundary. It must hold exactly what the model saw
// the first time — the projected payload — never the raw child output. Storing
// the raw output persisted real assetIds and signed URLs in the host's store
// AND fed the model a payload it had never seen on resume, around the
// projection at the return site.
describe('dispatchAgent tool-result transcript', () => {
  async function runWithTranscript(opts: { childOutput: unknown; bridge?: AgentAssetBridge }) {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(childPattern())
    registry.register(agentPattern())
    const capture: { result?: unknown } = {}
    const transcriptStore = new InMemoryTranscriptStore()
    const rt = new InlineRuntime({
      store: new MemoryJobStore() as never,
      registry,
      router: makeRouter(opts.childOutput),
      agentRunImpl: makeRunImpl(capture),
      transcriptStore,
      ...(opts.bridge ? { assetBridge: opts.bridge } : {}),
    })
    const job = await rt.submitJob({ patternId: 'agent_projection', input: { prompt: 'go' } })
    expect(job.status).toBe('done')
    // runId is the dispatching job's own id for a fresh (non-resumed) run.
    const entries = await transcriptStore.readAll(job.id)
    const toolResults = entries.filter((m) => m.kind === 'tool-result')
    return { loopSaw: capture.result, toolResults }
  }

  it('no bridge: the persisted tool-result is the projected payload, byte-equal to what the loop saw', async () => {
    const { loopSaw, toolResults } = await runWithTranscript({ childOutput: RAW_MEDIA_OUTPUT })
    // Exactly one dispatch_pattern tool-result was recorded (the finish tool
    // does not go through this path).
    const ours = toolResults.filter(
      (m) => (m.raw as { pattern_id?: string }).pattern_id === 'child-gen',
    )
    expect(ours).toHaveLength(1)
    const persisted = (ours[0].raw as { output: unknown }).output
    expectNoLeak(persisted)
    expect(persisted).toEqual(loopSaw)
  })

  it('bridge present: the persisted tool-result carries the handle, not the assetId', async () => {
    const seen: { stamped?: unknown } = {}
    const { loopSaw, toolResults } = await runWithTranscript({
      childOutput: RAW_MEDIA_OUTPUT,
      bridge: makeStampingBridge(seen),
    })
    const ours = toolResults.filter(
      (m) => (m.raw as { pattern_id?: string }).pattern_id === 'child-gen',
    )
    expect(ours).toHaveLength(1)
    const persisted = (ours[0].raw as { output: unknown }).output
    expectNoLeak(persisted)
    expect(persisted).toEqual(loopSaw)
    expect((persisted as { assets: Array<{ handle: string }> }).assets[0].handle).toBe('image_1')
  })
})
