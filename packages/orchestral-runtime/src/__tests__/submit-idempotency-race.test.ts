// Two same-key submits that overlap must produce ONE job and ONE model call.
// A read-then-insert pair cannot guarantee that: both submits await the
// lookup, both miss, both insert. The atomic `JobStore.insertIfAbsent` is what
// settles the winner, and the loser returns the winner's row instead of
// dispatching. Without it this suite sees two provider calls — i.e. the user
// is billed twice for one request.

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { silentDiagnosticsLogger, PatternRegistry } from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

function makeRouter(onCall: () => void): CapabilityRouter {
  const cap = {
    modelId: 'fake:gpt',
    provider: 'fake',
    tags: [],
    capabilities: ['text_to_image'],
    inputs: ['text'] as Modality[],
    outputs: ['image'] as Modality[],
    source: 'user',
    async call() {
      onCall()
      // Yield so a concurrent submit gets a fair chance to interleave while
      // this one is still in flight — the real-world shape of the race.
      await new Promise((r) => setTimeout(r, 5))
      return { output: { ok: true } } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function makeRuntime(store: InMemoryJobStore, onCall: () => void): InlineRuntime {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  const atomic = {
    id: 'text_to_image',
    kind: 'atomic',
    description: 'gen',
    primary: { tool: { description: 'g', inputs: z.object({ prompt: z.string() }) } },
    outputs: z.object({ ok: z.boolean() }),
  } as unknown as AtomicPattern
  registry.register(atomic as unknown as Parameters<typeof registry.register>[0])
  return new InlineRuntime({
    router: makeRouter(onCall),
    registry,
    store: store as never,
  })
}

describe('submitJob idempotency under concurrency', () => {
  it('dispatches once when two identical submits race (derived key)', async () => {
    const onCall = vi.fn()
    const store = new InMemoryJobStore()
    const runtime = makeRuntime(store, onCall)
    const spec = { patternId: 'text_to_image', input: { prompt: 'a cat' } }

    const [a, b] = await Promise.all([
      runtime.submitJob(spec as never),
      runtime.submitJob(spec as never),
    ])

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(a.id).toBe(b.id)
    expect((await store.query()).length).toBe(1)

    // Both callers get a real row, not a phantom: the winner is terminal, and
    // the loser gets handed the live row it attached to — canonical status
    // only, never 'error'.
    expect(a.status).toBe('done')
    expect(['queued', 'running', 'done']).toContain(b.status)
    expect((await store.get(a.id))?.status).toBe('done')
  })

  it('dispatches once when two submits race on an explicit idempotencyKey', async () => {
    const onCall = vi.fn()
    const store = new InMemoryJobStore()
    const runtime = makeRuntime(store, onCall)

    const [a, b] = await Promise.all([
      runtime.submitJob({
        patternId: 'text_to_image',
        input: { prompt: 'x' },
        idempotencyKey: 'k-explicit',
      } as never),
      runtime.submitJob({
        patternId: 'text_to_image',
        input: { prompt: 'y' },
        idempotencyKey: 'k-explicit',
      } as never),
    ])

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(a.id).toBe(b.id)
    expect((await store.query()).length).toBe(1)
  })
})
