import { describe, expect, it, vi } from 'vitest'
import type {
  CapabilityRouter,
  DispatchMiddleware,
  Job,
  JobSpec,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

// Locks the fire-and-forget contract
// of submitAgentAsync and the dedup-hit re-attach.
//
// Harness avoids the real dispatch path entirely: a `short-circuit`
// middleware completes the job right after INSERT, so we never need a real
// pattern body or router. The pattern only has to exist (truthiness check)
// for the non-error paths.

const KNOWN = 'agent_demo'

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = Date.now()
  return {
    id: overrides.id ?? 'job-1',
    patternId: overrides.patternId ?? KNOWN,
    idempotencyKey: overrides.idempotencyKey ?? 'key-1',
    status: overrides.status ?? 'queued',
    input: overrides.input ?? {},
    output: overrides.output ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.jobKind !== undefined ? { jobKind: overrides.jobKind } : {}),
  } as Job
}

// Shipped InMemoryJobStore + thin instrumentation (insert tally + a `seed`
// helper that pre-populates an "already existing" row without counting as a
// fresh submit). The store logic under test is the real one from
// @orchestral/core — only the assertion hooks live here.
class MemoryJobStore extends InMemoryJobStore {
  insertCount = 0
  readonly inserted: Job[] = []

  override async insert(job: Job): Promise<void> {
    this.insertCount++
    this.inserted.push({ ...job })
    await super.insert(job)
  }
  /** The submit path writes through the atomic dedup-or-create, so the tally
   *  lives here too — counted only when this call is the one that inserted. */
  override async insertIfAbsent(job: Job): Promise<Job> {
    const winner = await super.insertIfAbsent(job)
    if (winner.id === job.id) {
      this.insertCount++
      this.inserted.push({ ...job })
    }
    return winner
  }
  /** Pre-seed a row as if it already existed — bypasses the insert tally. */
  seed(job: Job): void {
    void super.insert(job)
  }
}

function makeRuntime(
  store: MemoryJobStore,
  onJobCreated?: (jobId: string, spec: JobSpec) => void,
): InlineRuntime {
  const registry = {
    get: (id: string) => (id === KNOWN ? ({} as never) : undefined),
  } as unknown as PatternRegistry
  const shortCircuit: DispatchMiddleware = {
    beforeDispatch: () => ({ kind: 'short-circuit', output: { ok: true } }),
  }
  return new InlineRuntime({
    store: store as never,
    registry,
    router: {} as unknown as CapabilityRouter,
    middleware: [shortCircuit],
    ...(onJobCreated ? { onJobCreated } : {}),
  })
}

describe('InlineRuntime.submitAgentAsync — fire-and-forget contract', () => {
  it('resolves with the addressable jobId and stamps jobKind="agent" on the row', async () => {
    const store = new MemoryJobStore()
    const rt = makeRuntime(store)

    const { jobId } = await rt.submitAgentAsync({ patternId: KNOWN, input: { x: 1 } })

    expect(jobId).toBeTruthy()
    expect(store.insertCount).toBe(1)
    expect(store.inserted[0].id).toBe(jobId)
    expect(store.inserted[0].jobKind).toBe('agent')
  })

  it('rejects on a pre-INSERT error and never inserts a row', async () => {
    const store = new MemoryJobStore()
    const rt = makeRuntime(store)

    await expect(
      rt.submitAgentAsync({ patternId: 'not-registered', input: {} }),
    ).rejects.toThrow(/PATTERN_NOT_REGISTERED/)
    expect(store.insertCount).toBe(0)
  })

  it('resolves a dedup hit with the existing jobId without inserting again', async () => {
    // Without the per-call onJobCreated firing on the dedup-hit branch, this
    // Promise would never resolve and the test would hang — that is the
    // fire-and-forget regression this guards.
    const store = new MemoryJobStore()
    store.seed(
      makeJob({ id: 'existing', idempotencyKey: 'dup-key', status: 'running', jobKind: 'agent' }),
    )
    const rt = makeRuntime(store)

    const { jobId } = await rt.submitAgentAsync({
      patternId: KNOWN,
      input: { x: 1 },
      idempotencyKey: 'dup-key',
    })

    expect(jobId).toBe('existing')
    expect(store.insertCount).toBe(0)
  })

  it('re-fires the constructor onJobCreated hook on an agent dedup hit (I5)', async () => {
    const store = new MemoryJobStore()
    store.seed(
      makeJob({ id: 'existing', idempotencyKey: 'dup-key', status: 'running', jobKind: 'agent' }),
    )
    const onJobCreated = vi.fn()
    const rt = makeRuntime(store, onJobCreated)

    await rt.submitAgentAsync({ patternId: KNOWN, input: { x: 1 }, idempotencyKey: 'dup-key' })

    // The fan-out subscription (host side) lives only in this hook; re-firing
    // it on the dedup hit is what re-attaches it for the deduped jobId.
    expect(onJobCreated).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({ jobKind: 'agent' }),
    )
  })

  it('does NOT re-fire onJobCreated on a non-agent dedup hit', async () => {
    // The I5 re-fire is gated on jobKind==='agent' so the inner-job cascade
    // trackers are never double-bound for regular submitJob dedup hits.
    const store = new MemoryJobStore()
    store.seed(makeJob({ id: 'existing2', idempotencyKey: 'dup2', status: 'running' }))
    const onJobCreated = vi.fn()
    const rt = makeRuntime(store, onJobCreated)

    await rt.submitJob({ patternId: KNOWN, input: { x: 1 }, idempotencyKey: 'dup2' })

    expect(onJobCreated).not.toHaveBeenCalled()
    expect(store.insertCount).toBe(0)
  })
})
