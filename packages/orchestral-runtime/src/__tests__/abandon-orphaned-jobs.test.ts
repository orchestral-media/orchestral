// Orphan abandonment — after an app restart, the store can hold job rows
// stuck in `running` / `queued` with no controller left to settle them (the
// process that owned them died). abandonOrphanedJobs() sweeps those orphans to
// `stale` and fans out a `job:stale` event so any reopened chat card stops
// spinning. The work is not resumed.
//
// This pins both the transition (running/queued → stale) and the fanout, and
// guards that already-terminal rows are left untouched.

import { describe, expect, it, vi } from 'vitest'

import type { Job, JobEvent } from '@orchestral/core'
import { silentDiagnosticsLogger, PatternRegistry } from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

function makeRuntime(store: MemoryJobStore): InlineRuntime {
  return new InlineRuntime({
    // abandonOrphanedJobs only touches the store; router/registry are never reached.
    router: {} as never,
    registry: new PatternRegistry({ logger: silentDiagnosticsLogger }),
    store: store as never,
  })
}

function orphan(over: Partial<Job> = {}): Job {
  const now = Date.now()
  return {
    id: 'orphan-1',
    patternId: 'meta_demo' as Job['patternId'],
    idempotencyKey: 'k-orphan-1',
    status: 'running',
    input: {},
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

describe('runtime.abandonOrphanedJobs (after a crash)', () => {
  it('transitions orphaned running/queued rows to stale and returns them', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    await store.insert(orphan({ id: 'q1', idempotencyKey: 'k2', status: 'queued' }))
    // A terminal row it must NOT touch.
    await store.insert(orphan({ id: 'd1', idempotencyKey: 'k3', status: 'done' }))

    const runtime = makeRuntime(store)
    const abandoned = await runtime.abandonOrphanedJobs()

    // Both orphans came back; the done row did not.
    expect(abandoned.map((j) => j.id).sort()).toEqual(['q1', 'r1'])
    expect(abandoned.every((j) => j.status === 'stale')).toBe(true)

    // The store rows are now stale; the terminal row is untouched.
    expect((await store.get('r1'))!.status).toBe('stale')
    expect((await store.get('q1'))!.status).toBe('stale')
    expect((await store.get('d1'))!.status).toBe('done')
  })

  it('fans out a job:stale event for each abandoned job', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    const runtime = makeRuntime(store)

    const events: JobEvent[] = []
    runtime.subscribe('r1', (e) => events.push(e))

    await runtime.abandonOrphanedJobs()

    expect(events.some((e) => e.type === 'job:stale' && e.job.id === 'r1')).toBe(true)
  })

  it('is a no-op when there are no orphaned rows', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'd1', idempotencyKey: 'k1', status: 'done' }))
    const runtime = makeRuntime(store)

    const abandoned = await runtime.abandonOrphanedJobs()
    expect(abandoned).toEqual([])
    expect((await store.get('d1'))!.status).toBe('done')
  })

  it('keeps going if one row fails to update (best-effort)', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    await store.insert(orphan({ id: 'r2', idempotencyKey: 'k2', status: 'running' }))
    const runtime = makeRuntime(store)

    // r1's update throws; the sweep must catch and proceed to the other row.
    // Keyed on the id, not on call order — the sweep does not promise which
    // row it visits first, and call-order mocks flip under coverage timing.
    const realUpdate = store.update.bind(store)
    const spy = vi
      .spyOn(store, 'update')
      .mockImplementation(async (id, patch) => {
        if (id === 'r1') throw new Error('boom')
        return realUpdate(id, patch)
      })

    const abandoned = await runtime.abandonOrphanedJobs()
    // The failing row is skipped, the other abandoned.
    expect(abandoned.map((j) => j.id)).toEqual(['r2'])
    expect((await store.get('r2'))!.status).toBe('stale')
    // r1's update never landed — it stays as the sweep found it.
    expect((await store.get('r1'))!.status).toBe('running')
    spy.mockRestore()
  })
})
