import { beforeEach, describe, expect, it } from 'vitest'

import type { Job } from '../job'
import { InMemoryJobStore } from '../job-store-memory'

// jobKind round-trip. The load-bearing case is the omitted-default: a durable
// store folds a missing jobKind to 'pattern' via its column DEFAULT, so the
// Map-backed store must read back the same narrow JobKind for an unset key.
// Without that, `jobKind` is not portable across JobStore implementations and
// an async-agent row could silently demote to 'pattern' on read.

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = Date.now()
  return {
    id: overrides.id ?? 'job-1',
    patternId: overrides.patternId ?? 'text-to-image',
    idempotencyKey: overrides.idempotencyKey ?? 'key-1',
    status: overrides.status ?? 'queued',
    input: overrides.input ?? { prompt: 'cat' },
    output: overrides.output ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.jobKind !== undefined ? { jobKind: overrides.jobKind } : {}),
  } as Job
}

describe('InMemoryJobStore — jobKind normalization', () => {
  let store: InMemoryJobStore

  beforeEach(() => {
    store = new InMemoryJobStore()
  })

  it('defaults an omitted jobKind to "pattern" on read', async () => {
    await store.insert(makeJob({ id: 'p1', idempotencyKey: 'k-p1' }))
    expect((await store.get('p1'))?.jobKind).toBe('pattern')
  })

  it('round-trips an explicit jobKind="agent"', async () => {
    await store.insert(makeJob({ id: 'a1', idempotencyKey: 'k-a1', jobKind: 'agent' }))
    expect((await store.get('a1'))?.jobKind).toBe('agent')
  })

  it('preserves jobKind="agent" across a status-only update', async () => {
    await store.insert(
      makeJob({ id: 'a2', idempotencyKey: 'k-a2', jobKind: 'agent', status: 'queued' }),
    )
    await store.update('a2', { status: 'running' })

    const updated = await store.get('a2')
    expect(updated?.jobKind).toBe('agent')
    expect(updated?.status).toBe('running')
  })

  it('normalizes jobKind in query() and findByIdempotencyKey() results', async () => {
    await store.insert(makeJob({ id: 'q1', idempotencyKey: 'k-q1' }))

    const [queried] = await store.query({ patternId: 'text-to-image' })
    expect(queried?.jobKind).toBe('pattern')

    const byKey = await store.findByIdempotencyKey('k-q1')
    expect(byKey?.jobKind).toBe('pattern')
  })

  it('emits events carrying a normalized jobKind', async () => {
    const seen: (string | undefined)[] = []
    store.subscribe((ev) => seen.push(ev.job.jobKind))
    await store.insert(makeJob({ id: 's1', idempotencyKey: 'k-s1' }))
    expect(seen).toEqual(['pattern'])
  })
})

describe('InMemoryJobStore — conditionalUpdate', () => {
  let store: InMemoryJobStore

  beforeEach(() => {
    store = new InMemoryJobStore()
  })

  it('writes and returns true when the status guard matches', async () => {
    await store.insert(makeJob({ id: 'c1', idempotencyKey: 'k-c1', status: 'running' }))
    const wrote = await store.conditionalUpdate('c1', { status: 'cancelled' }, 'running')
    expect(wrote).toBe(true)
    expect((await store.get('c1'))?.status).toBe('cancelled')
  })

  it('no-ops and returns false when the status guard does not match', async () => {
    await store.insert(makeJob({ id: 'c2', idempotencyKey: 'k-c2', status: 'done' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    const wrote = await store.conditionalUpdate('c2', { status: 'cancelled' }, 'running')

    expect(wrote).toBe(false)
    expect((await store.get('c2'))?.status).toBe('done')
    expect(events).toEqual([]) // no write → no event
  })

  it('emits the transition event only on a successful write', async () => {
    await store.insert(makeJob({ id: 'c3', idempotencyKey: 'k-c3', status: 'running' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    await store.conditionalUpdate('c3', { status: 'cancelled' }, 'running')

    expect(events).toEqual(['job:cancelled'])
  })

  it('throws JOB_NOT_FOUND when the job does not exist', async () => {
    await expect(
      store.conditionalUpdate('missing', { status: 'cancelled' }, 'running'),
    ).rejects.toThrow(/JOB_NOT_FOUND/)
  })
})

describe('InMemoryJobStore — insertIfAbsent (atomic dedup-or-create)', () => {
  let store: InMemoryJobStore

  beforeEach(() => {
    store = new InMemoryJobStore()
  })

  it('inserts and returns the submitted row when the key is free', async () => {
    const winner = await store.insertIfAbsent(makeJob({ id: 'i1', idempotencyKey: 'k-i1' }))
    expect(winner.id).toBe('i1')
    expect(winner.jobKind).toBe('pattern')
    expect((await store.get('i1'))?.status).toBe('queued')
  })

  it('returns the existing canonical row and writes nothing on a key collision', async () => {
    await store.insert(makeJob({ id: 'first', idempotencyKey: 'k-dup', status: 'running' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    const winner = await store.insertIfAbsent(makeJob({ id: 'second', idempotencyKey: 'k-dup' }))

    expect(winner.id).toBe('first')
    expect(await store.get('second')).toBeNull()
    expect(events).toEqual([]) // no insert → no job:submitted
  })

  it('still inserts when the only same-key row is non-canonical (retry after failure)', async () => {
    await store.insert(makeJob({ id: 'failed', idempotencyKey: 'k-retry', status: 'error' }))
    const winner = await store.insertIfAbsent(makeJob({ id: 'retry', idempotencyKey: 'k-retry' }))
    expect(winner.id).toBe('retry')
  })

  it('rejects an invalid status even when the key is already taken', async () => {
    // The dedup hit must not become a validation bypass: a caller handing over
    // a status the store can never write is a bug regardless of whether some
    // other row happens to own the key — validation comes before the
    // canonical lookup in every conforming store.
    await store.insert(makeJob({ id: 'held', idempotencyKey: 'k-bad', status: 'running' }))

    await expect(
      store.insertIfAbsent(
        makeJob({ id: 'bogus', idempotencyKey: 'k-bad', status: 'nonsense' as never }),
      ),
    ).rejects.toThrow(/JOB_STORE_INVALID_STATUS/)
    expect(await store.get('bogus')).toBeNull()
  })

  it('serializes concurrent same-key callers onto one row', async () => {
    const [a, b] = await Promise.all([
      store.insertIfAbsent(makeJob({ id: 'race-a', idempotencyKey: 'k-race' })),
      store.insertIfAbsent(makeJob({ id: 'race-b', idempotencyKey: 'k-race' })),
    ])
    expect(a.id).toBe(b.id)
    expect((await store.query()).length).toBe(1)
  })
})

describe('InMemoryJobStore — transition guard', () => {
  let store: InMemoryJobStore

  beforeEach(() => {
    store = new InMemoryJobStore()
  })

  it('refuses to move a terminal row to another status', async () => {
    await store.insert(makeJob({ id: 't1', idempotencyKey: 'k-t1', status: 'done' }))

    await expect(store.update('t1', { status: 'running' })).rejects.toThrow(
      /JOB_STORE_ILLEGAL_TRANSITION/,
    )
  })

  it('leaves the row and the subscribers untouched when it refuses', async () => {
    // A refused write must leave no trace: no half-applied patch, no event.
    // Otherwise the guard would only stop the status and let the rest of the
    // row drift, which is worse than not guarding at all.
    await store.insert(makeJob({ id: 't2', idempotencyKey: 'k-t2', status: 'stale' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    await expect(
      store.update('t2', { status: 'running', output: { sneaked: true } }),
    ).rejects.toThrow(/JOB_STORE_ILLEGAL_TRANSITION/)

    const row = await store.get('t2')
    expect(row?.status).toBe('stale')
    expect(row?.output).toBeNull()
    expect(events).toEqual([])
  })

  it('carries the refused pair on the thrown error', async () => {
    await store.insert(makeJob({ id: 't3', idempotencyKey: 'k-t3', status: 'cancelled' }))

    const err = await store.update('t3', { status: 'done' }).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('JOB_STORE_ILLEGAL_TRANSITION')
    expect((err as { details?: unknown }).details).toEqual({
      jobId: 't3',
      from: 'cancelled',
      to: 'done',
    })
  })

  it('refuses a backward transition into queued', async () => {
    await store.insert(makeJob({ id: 't4', idempotencyKey: 'k-t4', status: 'running' }))

    await expect(store.update('t4', { status: 'queued' })).rejects.toThrow(
      /JOB_STORE_ILLEGAL_TRANSITION/,
    )
    expect((await store.get('t4'))?.status).toBe('running')
  })

  it('still accepts a same-status patch on a settled row, as job:output', async () => {
    await store.insert(makeJob({ id: 't5', idempotencyKey: 'k-t5', status: 'done' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    await store.update('t5', { output: { late: true } })

    expect((await store.get('t5'))?.output).toEqual({ late: true })
    expect(events).toEqual(['job:output'])
  })

  it('guards conditionalUpdate the same way once its status guard matches', async () => {
    // The ifStatus guard answers "is this still the row I meant?", not "is this
    // a legal move" — a matched guard still has to clear the state machine.
    await store.insert(makeJob({ id: 't6', idempotencyKey: 'k-t6', status: 'done' }))

    await expect(
      store.conditionalUpdate('t6', { status: 'running' }, 'done'),
    ).rejects.toThrow(/JOB_STORE_ILLEGAL_TRANSITION/)
    expect((await store.get('t6'))?.status).toBe('done')
  })

  it('emits the lifecycle event the state machine names on a legal move', async () => {
    await store.insert(makeJob({ id: 't7', idempotencyKey: 'k-t7', status: 'queued' }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type))

    await store.update('t7', { status: 'running' })
    await store.update('t7', { status: 'done', output: { ok: true } })

    expect(events).toEqual(['job:started', 'job:completed'])
  })
})
