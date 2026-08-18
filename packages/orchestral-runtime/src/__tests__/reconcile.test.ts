// Crash-recovery reconcile — after an app restart, the store can hold job rows
// stuck in `running` / `queued` with no controller left to settle them (the
// process that owned them died). reconcile() sweeps those orphans to `stale`
// and fans out a `job:stale` event so any reopened chat card stops spinning.
//
// This pins both the transition (running/queued → stale) and the fanout, and
// guards that reconcile() leaves already-terminal rows untouched.

import { describe, expect, it, vi } from 'vitest'

import type { Job, JobEvent } from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'

import { InlineRuntime } from '../inline'

function makeRuntime(store: MemoryJobStore): InlineRuntime {
  return new InlineRuntime({
    // reconcile only touches the store; router/registry are never reached.
    router: {} as never,
    registry: new PatternRegistry(),
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

describe('runtime.reconcile (crash recovery)', () => {
  it('transitions orphaned running/queued rows to stale and returns them', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    await store.insert(orphan({ id: 'q1', idempotencyKey: 'k2', status: 'queued' }))
    // A terminal row reconcile must NOT touch.
    await store.insert(orphan({ id: 'd1', idempotencyKey: 'k3', status: 'done' }))

    const runtime = makeRuntime(store)
    const recovered = await runtime.reconcile()

    // Both orphans came back; the done row did not.
    expect(recovered.map((j) => j.id).sort()).toEqual(['q1', 'r1'])
    expect(recovered.every((j) => j.status === 'stale')).toBe(true)

    // The store rows are now stale; the terminal row is untouched.
    expect((await store.get('r1'))!.status).toBe('stale')
    expect((await store.get('q1'))!.status).toBe('stale')
    expect((await store.get('d1'))!.status).toBe('done')
  })

  it('fans out a job:stale event for each recovered job', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    const runtime = makeRuntime(store)

    const events: JobEvent[] = []
    runtime.subscribe('r1', (e) => events.push(e))

    await runtime.reconcile()

    expect(events.some((e) => e.type === 'job:stale' && e.job.id === 'r1')).toBe(true)
  })

  it('is a no-op when there are no orphaned rows', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'd1', idempotencyKey: 'k1', status: 'done' }))
    const runtime = makeRuntime(store)

    const recovered = await runtime.reconcile()
    expect(recovered).toEqual([])
    expect((await store.get('d1'))!.status).toBe('done')
  })

  it('keeps going if one row fails to update (best-effort recovery)', async () => {
    const store = new MemoryJobStore()
    await store.insert(orphan({ id: 'r1', idempotencyKey: 'k1', status: 'running' }))
    await store.insert(orphan({ id: 'r2', idempotencyKey: 'k2', status: 'running' }))
    const runtime = makeRuntime(store)

    // r1's update throws; reconcile must catch and proceed to the other row.
    // Keyed on the id, not on call order — reconcile does not promise which
    // row it visits first, and call-order mocks flip under coverage timing.
    const realUpdate = store.update.bind(store)
    const spy = vi
      .spyOn(store, 'update')
      .mockImplementation(async (id, patch) => {
        if (id === 'r1') throw new Error('boom')
        return realUpdate(id, patch)
      })

    const recovered = await runtime.reconcile()
    // The failing row is skipped, the other recovered.
    expect(recovered.map((j) => j.id)).toEqual(['r2'])
    expect((await store.get('r2'))!.status).toBe('stale')
    // r1's update never landed — it stays as reconcile found it.
    expect((await store.get('r1'))!.status).toBe('running')
    spy.mockRestore()
  })
})
