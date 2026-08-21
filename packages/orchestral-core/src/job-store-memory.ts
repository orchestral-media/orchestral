// InMemoryJobStore — process-local Map-backed JobStore. dev / test only;
// everything is lost when the process exits.
//
// Reference implementation of the storage-agnostic half of the `JobStore`
// contract — a durable host store must reproduce all of it:
//   • eventForTransition — the lifecycle / 'job:submitted' / 'job:output' map
//   • findByIdempotencyKey / insertIfAbsent — queued|running|done
//     canonical-only dedup policy, and the same atomic dedup-or-create
//   • JOB_STORE_INVALID_STATUS — rejected on the way in, before any lookup,
//     so a dedup hit can't wave through a status the store cannot write
//   • query — status / patternId / sessionId / since predicates, ordered
//     createdAt DESC, id ASC
//   • subscribe + emit — try/catch fanout so one bad listener can't break others
//
// A host injects its own durable JobStore (e.g. SQLite-backed) to persist
// across processes; both satisfy the same JobStore contract so the runtime
// never branches on which one is wired in.

import type { Job, JobEvent, JobStatus } from './job'
import type { JobQueryFilter, JobStore, Unsubscribe } from './job-store'

const VALID_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'done',
  'error',
  'cancelled',
  'stale',
] as const

function assertJobStatus(status: unknown): asserts status is JobStatus {
  if (typeof status !== 'string' || !(VALID_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`JOB_STORE_INVALID_STATUS: ${String(status)}`)
  }
}

// A SQL-backed store gets this for free from a column DEFAULT of 'pattern';
// the Map-backed store has no schema, so an omitted `jobKind` would read back
// `undefined`. Normalize at every store-out boundary so any conforming store
// returns the same narrow `JobKind` for an unset key.
function normalizeJobKind(job: Job): Job {
  return job.jobKind === undefined ? { ...job, jobKind: 'pattern' } : job
}

/**
 * Decide which JobEvent type matches a status transition. The store always
 * carries a snapshot of the post-transition Job, so subscribers never need
 * to refetch. Returns null when the update doesn't map to any meaningful
 * event (e.g. a backward transition into 'queued').
 *
 * Progress / artifact signals are NOT produced here; those come from
 * provider-side CallEvents in
 * the runtime. The store only emits lifecycle transitions and the
 * column-level 'job:output' update.
 */
function eventForTransition(prev: JobStatus | null, next: Job): JobEvent | null {
  // First write — Job appeared as 'queued'.
  if (prev === null) return { type: 'job:submitted', job: next }
  if (prev === next.status) {
    // Same-status row update (an output write before running -> done lands, or
    // a metadata patch). Surface as 'job:output'; 'job:progress' is reserved
    // for real provider-fraction signals fed through CallEvents.onProgress.
    return { type: 'job:output', job: next }
  }
  switch (next.status) {
    case 'running':
      return { type: 'job:started', job: next }
    case 'done':
      return { type: 'job:completed', job: next }
    case 'error':
      return { type: 'job:failed', job: next }
    case 'cancelled':
      return { type: 'job:cancelled', job: next }
    case 'stale':
      return { type: 'job:stale', job: next }
    // Backward transition into 'queued' from another status is degenerate.
    default:
      return null
  }
}

/**
 * Map-backed `JobStore`. No real transactions:
 * each insert / update runs to completion synchronously on the single-threaded
 * event loop, so the read-modify-write is already atomic with respect to other
 * store calls — no transaction wrapper is needed.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>()
  private readonly subscribers = new Set<(event: JobEvent) => void>()
  private readonly onSubscriberError?: (error: unknown, event: JobEvent) => void

  /**
   * @param options.onSubscriberError Called when a subscriber callback throws.
   *   Delivery to the remaining subscribers continues either way; without a
   *   handler the throw is swallowed, since a library has no business writing
   *   to the process's output streams.
   */
  constructor(options: {
    onSubscriberError?: (error: unknown, event: JobEvent) => void
  } = {}) {
    this.onSubscriberError = options.onSubscriberError
  }

  async insert(job: Job): Promise<void> {
    assertJobStatus(job.status)
    this.insertSync(job)
  }

  async insertIfAbsent(job: Job): Promise<Job> {
    // Validate before the canonical lookup: a malformed status must be
    // rejected whether or not the key happens to be taken, otherwise dedup
    // hits would silently accept rows the store can never write. Any
    // conforming store must order it the same way.
    assertJobStatus(job.status)
    // Check and write in one synchronous block: no await between the lookup
    // and the map write, so a concurrent submitter can never interleave and
    // land a second row for the same key.
    const existing = this.findCanonical(job.idempotencyKey)
    if (existing) return { ...existing }
    return this.insertSync(job)
  }

  private insertSync(job: Job): Job {
    // Defensive copy so a later external mutation of the caller's object can't
    // reach into the store (the sqlite store gets this for free via serialize).
    // normalizeJobKind also folds an omitted jobKind to 'pattern' the same way
    // the sqlite DEFAULT does, so reads + emitted events stay store-agnostic.
    const stored = normalizeJobKind({ ...job })
    this.jobs.set(stored.id, stored)
    const event = eventForTransition(null, stored)
    if (event) this.emit(event)
    return { ...stored }
  }

  async update(id: string, patch: Partial<Job>): Promise<void> {
    const cur = this.jobs.get(id)
    if (!cur) {
      throw new Error(`JOB_NOT_FOUND: ${id}`)
    }
    const prevStatus = cur.status
    const merged: Job = normalizeJobKind({
      ...cur,
      ...patch,
      // updatedAt always bumped — patch.updatedAt can override for tests.
      updatedAt: patch.updatedAt ?? Date.now(),
    })
    assertJobStatus(merged.status)
    this.jobs.set(id, merged)
    const event = eventForTransition(prevStatus, merged)
    if (event) this.emit(event)
  }

  async conditionalUpdate(
    id: string,
    patch: Partial<Job>,
    ifStatus: JobStatus,
  ): Promise<boolean> {
    const cur = this.jobs.get(id)
    if (!cur) {
      throw new Error(`JOB_NOT_FOUND: ${id}`)
    }
    // The whole check-and-write runs synchronously on the event loop, so the
    // guard and the write are atomic with respect to any other store call.
    if (cur.status !== ifStatus) return false
    const prevStatus = cur.status
    const merged: Job = normalizeJobKind({
      ...cur,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    })
    assertJobStatus(merged.status)
    this.jobs.set(id, merged)
    const event = eventForTransition(prevStatus, merged)
    if (event) this.emit(event)
    return true
  }

  async get(id: string): Promise<Job | null> {
    const job = this.jobs.get(id)
    return job ? { ...job } : null
  }

  async findByIdempotencyKey(key: string): Promise<Job | null> {
    const best = this.findCanonical(key)
    return best ? { ...best } : null
  }

  /**
   * Canonical-row lookup shared by `findByIdempotencyKey` and the atomic
   * `insertIfAbsent`. Only in-flight or successfully-completed rows count:
   *   queued / running -> dedupe duplicate submits onto the live job
   *   done             -> classic idempotency: return the prior result
   * error / stale / cancelled deliberately do NOT match so the caller can
   * retry after an explicit failure. Newest createdAt wins on ties.
   * Returns the stored object — callers copy before handing it out.
   */
  private findCanonical(key: string): Job | null {
    let best: Job | null = null
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey !== key) continue
      if (
        job.status !== 'queued' &&
        job.status !== 'running' &&
        job.status !== 'done'
      ) {
        continue
      }
      if (best === null || job.createdAt > best.createdAt) {
        best = job
      }
    }
    return best
  }

  async query(filter?: JobQueryFilter): Promise<readonly Job[]> {
    const statusSet =
      filter?.status && filter.status.length > 0
        ? new Set<JobStatus>(filter.status)
        : null
    const out: Job[] = []
    for (const job of this.jobs.values()) {
      if (statusSet && !statusSet.has(job.status)) continue
      if (filter?.patternId && job.patternId !== filter.patternId) continue
      if (filter?.sessionId && job.sessionId !== filter.sessionId) continue
      if (typeof filter?.since === 'number' && job.createdAt < filter.since) {
        continue
      }
      out.push({ ...job })
    }
    // ORDER BY created_at DESC, id ASC — mirrors the sqlite store.
    out.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? b.createdAt - a.createdAt
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    )
    return out
  }

  subscribe(callback: (event: JobEvent) => void): Unsubscribe {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  private emit(event: JobEvent): void {
    // Snapshot the set before iterating so an unsubscribe inside a callback
    // doesn't skip later listeners. One throwing listener must not abort
    // delivery to the rest — subscribers are observers.
    for (const cb of [...this.subscribers]) {
      try {
        cb(event)
      } catch (e) {
        this.onSubscriberError?.(e, event)
      }
    }
  }
}
