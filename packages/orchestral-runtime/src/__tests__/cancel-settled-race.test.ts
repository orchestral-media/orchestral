// cancelJob check-then-act race (re-read guard).
//
// cancelJob reads the job status, checks it is non-terminal, aborts the
// controller, then writes status:'cancelled'. Because `store.get` is async the
// event loop yields between the read and the write — if the job's own
// completion path lands a terminal status in that window, an unconditional
// cancel write would silently overwrite a successful result and fan out
// 'job:cancelled' for work that actually finished. The guard re-reads after the
// abort and returns a no-op when the job already settled.

import { describe, expect, it } from 'vitest'

import type {
  CapabilityRouter,
  Job,
  JobEvent,
  JobStatus,
  ModelCapability,
} from '@orchestral/core'
import { PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'

// cancelJob never touches the router/registry — a minimal fake satisfies the
// constructor without dispatching anything.
function makeNoopRouter(): CapabilityRouter {
  const cap = {
    modelId: 'fake',
    provider: 'fake',
    tags: [],
    capabilities: [],
    inputs: [],
    outputs: [],
    source: 'user',
    async call() {
      return {}
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function makeJob(status: JobStatus): Job {
  const now = Date.now()
  return {
    id: 'job-1',
    patternId: 'p',
    idempotencyKey: 'k',
    status,
    input: {},
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  } as unknown as Job
}

function makeRuntime(store: unknown): InlineRuntime {
  return new InlineRuntime({
    router: makeNoopRouter(),
    registry: new PatternRegistry(),
    store: store as never,
  })
}

describe('cancelJob settled-race guard', () => {
  it('skips the cancel write when the job completes during the cancel window', async () => {
    // get() (top of cancelJob) reports 'running' → passes the terminal check.
    // The job's own completion path then lands 'done' during the cancel window,
    // so the guarded write finds a status mismatch and refuses — exactly the
    // race that the atomic conditionalUpdate closes.
    class RacingStore {
      readonly updates: Partial<Job>[] = []
      readonly condWrites: Partial<Job>[] = []
      private job = makeJob('running')
      async insert(): Promise<void> {}
      async update(_id: string, patch: Partial<Job>): Promise<void> {
        this.updates.push(patch)
        this.job = { ...this.job, ...patch }
      }
      async conditionalUpdate(
        _id: string,
        patch: Partial<Job>,
        ifStatus: JobStatus,
      ): Promise<boolean> {
        // Completion lands between the top read and this guarded write.
        if (this.job.status === 'running') {
          this.job = { ...this.job, status: 'done', output: { ok: true } }
        }
        if (this.job.status !== ifStatus) return false
        this.condWrites.push(patch)
        this.job = { ...this.job, ...patch }
        return true
      }
      async get(): Promise<Job | null> {
        return { ...this.job }
      }
      async findByIdempotencyKey(): Promise<Job | null> {
        return null
      }
      async query(): Promise<readonly Job[]> {
        return [this.job]
      }
      status(): JobStatus {
        return this.job.status
      }
    }

    const store = new RacingStore()
    const runtime = makeRuntime(store)
    const events: JobEvent['type'][] = []
    runtime.subscribe('job-1', (ev) => events.push(ev.type))

    await expect(runtime.cancelJob('job-1')).resolves.toBeUndefined()

    // The guard rejected both writes: no cancel persisted, no fanout, the
    // successful 'done' result is preserved. The unconditional path is unused.
    expect(store.condWrites).toEqual([])
    expect(store.updates).toEqual([])
    expect(store.status()).toBe('done')
    expect(events).not.toContain('job:cancelled')
  })

  it('still cancels a genuinely running job (no regression)', async () => {
    // Stays 'running' across every read until conditionalUpdate writes
    // 'cancelled' against the matching 'running' guard.
    class LiveStore {
      readonly updates: Partial<Job>[] = []
      readonly condWrites: Partial<Job>[] = []
      job = makeJob('running')
      async insert(): Promise<void> {}
      async update(_id: string, patch: Partial<Job>): Promise<void> {
        this.updates.push(patch)
        this.job = { ...this.job, ...patch }
      }
      async conditionalUpdate(
        _id: string,
        patch: Partial<Job>,
        ifStatus: JobStatus,
      ): Promise<boolean> {
        if (this.job.status !== ifStatus) return false
        this.condWrites.push(patch)
        this.job = { ...this.job, ...patch }
        return true
      }
      async get(): Promise<Job | null> {
        return { ...this.job }
      }
      async findByIdempotencyKey(): Promise<Job | null> {
        return null
      }
      async query(): Promise<readonly Job[]> {
        return [this.job]
      }
    }

    const store = new LiveStore()
    const runtime = makeRuntime(store)
    const events: JobEvent['type'][] = []
    runtime.subscribe('job-1', (ev) => events.push(ev.type))

    await runtime.cancelJob('job-1')

    // Exactly one guarded write lands 'cancelled'; the unconditional update is
    // never taken.
    expect(store.updates).toEqual([])
    expect(store.condWrites).toHaveLength(1)
    expect(store.condWrites[0]?.status).toBe('cancelled')
    expect(store.job.status).toBe('cancelled')
    expect(events).toContain('job:cancelled')
  })

  it('throws JOB_ALREADY_TERMINAL when the job is already settled before cancel', async () => {
    // The first read already sees a terminal status — the pre-existing guard
    // throws before any write is attempted.
    class DoneStore {
      readonly updates: Partial<Job>[] = []
      readonly condWrites: Partial<Job>[] = []
      private job = makeJob('done')
      async insert(): Promise<void> {}
      async update(_id: string, patch: Partial<Job>): Promise<void> {
        this.updates.push(patch)
      }
      async conditionalUpdate(_id: string, patch: Partial<Job>): Promise<boolean> {
        this.condWrites.push(patch)
        return false
      }
      async get(): Promise<Job | null> {
        return { ...this.job }
      }
      async findByIdempotencyKey(): Promise<Job | null> {
        return null
      }
      async query(): Promise<readonly Job[]> {
        return [this.job]
      }
    }

    const store = new DoneStore()
    const runtime = makeRuntime(store)

    await expect(runtime.cancelJob('job-1')).rejects.toThrow(/JOB_ALREADY_TERMINAL/)
    expect(store.updates).toEqual([])
    expect(store.condWrites).toEqual([])
  })
})
