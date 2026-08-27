// PatternBase.checkPermissions fires for every Pattern kind.
//
// It used to run only on the atomic path: the single call site sat below
// dispatch()'s meta and agent early returns, so a meta or agent Pattern that
// declared the hook was dispatched without it ever being consulted — a gate the
// host believed it had installed and did not. These tests pin the hook at all
// three branches, and pin what each kind's hook receives, since the two
// pre-branch kinds are handed the pre-fork context rather than the atomic
// path's forked one.

import { describe, expect, it } from 'vitest'

import {
  silentDiagnosticsLogger,
  PatternRegistry,
  type AgentPattern,
  type AtomicPattern,
  type CapabilityRouter,
  type DispatchContext,
  type MetaPattern,
  type ModelCapability,
  type PatternId,
  type PermissionResult,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

const DENIED: PermissionResult = { ok: false, reason: 'over quota' }

const textModel: ModelCapability = {
  capabilities: ['text-generation'],
  provider: 'test',
  modelId: 'echo',
  inputs: ['text'],
  outputs: ['text'],
  tags: [],
  source: 'user',
  async call<_I, O>(): Promise<{ output: O }> {
    return { output: { text: 'ran' } as O }
  },
}

const router: CapabilityRouter = {
  checkSatisfiable: () => ({ ok: true, candidates: [textModel] }),
  resolve: () => textModel,
}

function makeRuntime(registry: PatternRegistry) {
  return new InlineRuntime({ store: new InMemoryJobStore(), registry, router })
}

/** Records the ctx the hook was handed, so we can assert on its shape. */
function spyHook(result: PermissionResult) {
  const seen: { input: unknown; ctx: DispatchContext }[] = []
  return {
    seen,
    hook: (input: unknown, ctx: DispatchContext): PermissionResult => {
      seen.push({ input, ctx })
      return result
    },
  }
}

describe('checkPermissions — every kind', () => {
  it('denies an atomic dispatch', async () => {
    const spy = spyHook(DENIED)
    const atomic: AtomicPattern = {
      id: 'text-generation' as PatternId,
      kind: 'atomic',
      description: 'echo',
      primary: { tool: { description: 'echo', inputs: z.object({}) } },
      outputs: z.object({ text: z.string().max(64) }),
      checkPermissions: spy.hook,
    } as unknown as AtomicPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(atomic)
    // A denied dispatch settles as a failed Job whose JobError carries the
    // hook's reason — identical for all three kinds here.
    const job = await makeRuntime(registry).submitJob({
      patternId: 'text-generation' as PatternId,
      input: {},
    })
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/PERMISSION_DENIED: over quota/)
    expect(spy.seen).toHaveLength(1)
  })

  it('denies a meta dispatch — compose never starts', async () => {
    const spy = spyHook(DENIED)
    let composed = false
    const meta: MetaPattern = {
      id: 'meta_gated' as PatternId,
      kind: 'meta',
      description: 'gated',
      tool: { description: 'gated', inputs: z.object({}) },
      outputs: z.object({ ok: z.boolean() }),
      checkPermissions: spy.hook,
      async compose() {
        composed = true
        return { ok: true }
      },
    } as unknown as MetaPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(meta)
    const job = await makeRuntime(registry).submitJob({
      patternId: 'meta_gated' as PatternId,
      input: {},
    })
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/PERMISSION_DENIED: over quota/)
    expect(composed).toBe(false)
    expect(spy.seen).toHaveLength(1)
  })

  it('denies an agent dispatch — the inner loop is never driven', async () => {
    const spy = spyHook(DENIED)
    let ranLoop = false
    const agent: AgentPattern = {
      id: 'agent_gated' as PatternId,
      kind: 'agent',
      description: 'gated',
      primary: { tool: { description: 'gated', inputs: z.object({}) } },
      loop: { system: 'you are gated', toolPatternIds: [], modelTags: [] },
      checkPermissions: spy.hook,
    } as unknown as AgentPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(agent)
    const runtime = new InlineRuntime({
      store: new InMemoryJobStore(),
      registry,
      router,
      agentRunImpl: {
        run: async () => {
          ranLoop = true
          return { output: {} }
        },
      },
    } as unknown as ConstructorParameters<typeof InlineRuntime>[0])

    const job = await runtime.submitJob({
      patternId: 'agent_gated' as PatternId,
      input: { objective: 'x' },
    })
    expect(job.status).toBe('error')
    expect(job.error?.message).toMatch(/PERMISSION_DENIED: over quota/)
    expect(ranLoop).toBe(false)
    expect(spy.seen).toHaveLength(1)
  })

  it('passes the dispatch input and a usable ctx to a meta hook', async () => {
    const spy = spyHook({ ok: true })
    const meta: MetaPattern = {
      id: 'meta_allowed' as PatternId,
      kind: 'meta',
      description: 'allowed',
      tool: { description: 'allowed', inputs: z.object({ n: z.number() }) },
      outputs: z.object({ ok: z.boolean() }),
      checkPermissions: spy.hook,
      async compose() {
        return { ok: true }
      },
    } as unknown as MetaPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(meta)
    const job = await makeRuntime(registry).submitJob({
      patternId: 'meta_allowed' as PatternId,
      input: { n: 7 },
      sessionId: 'sess-1',
    })

    expect(job.status).toBe('done')
    expect(spy.seen[0].input).toEqual({ n: 7 })
    // The pre-fork minimum: a live signal plus what the spec already carried.
    expect(spy.seen[0].ctx.signal).toBeInstanceOf(AbortSignal)
    expect(spy.seen[0].ctx.signal.aborted).toBe(false)
    expect(spy.seen[0].ctx.sessionId).toBe('sess-1')
    expect(spy.seen[0].ctx.assets).toEqual([])
    // Correlation id is present on the gate context too, so a hook that meters
    // spend per submitted job can key on it.
    expect(spy.seen[0].ctx.rootJobId).toBe(job.id)
  })

  it('a Pattern with no hook dispatches untouched', async () => {
    const meta: MetaPattern = {
      id: 'meta_ungated' as PatternId,
      kind: 'meta',
      description: 'ungated',
      tool: { description: 'ungated', inputs: z.object({}) },
      outputs: z.object({ ok: z.boolean() }),
      async compose() {
        return { ok: true }
      },
    } as unknown as MetaPattern

    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(meta)
    const job = await makeRuntime(registry).submitJob({
      patternId: 'meta_ungated' as PatternId,
      input: {},
    })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ ok: true })
  })
})
