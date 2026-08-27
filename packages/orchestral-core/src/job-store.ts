// JobStore interface — host implements (sqlite / postgres / memory / kv).
// Runtime stays storage-agnostic.

import type { Job, JobEvent, JobStatus } from './job'

export interface JobQueryFilter {
  status?: readonly JobStatus[]
  patternId?: string
  sessionId?: string
  /** Lower bound on Job.createdAt (epoch ms). */
  since?: number
}

export type Unsubscribe = () => void

export interface JobStore {
  /**
   * Unconditional write. Does NOT look at `idempotencyKey` — two rows may
   * share a key (a host that logs every call keeps one row per call, and a
   * retry after an explicit failure legitimately re-uses the key of the
   * failed row). Callers that want dedup use `insertIfAbsent`.
   */
  insert(job: Job): Promise<void>
  /**
   * Atomic "dedup or create": if a canonical row already exists for
   * `job.idempotencyKey` — same match rule as `findByIdempotencyKey`, i.e.
   * status `queued / running / done` — return that row and write nothing;
   * otherwise insert `job` and return it. `result.id === job.id` tells the
   * caller which happened.
   *
   * Conformance requirement: the lookup and the insert MUST be one atomic
   * step. This is what makes idempotency actually hold — a caller doing
   * `findByIdempotencyKey` then `insert` has a window in which a concurrent
   * submit with the same key slips through and gets dispatched twice (real
   * money, twice). Host implementations back it with a single write
   * transaction (sqlite: `BEGIN IMMEDIATE` around SELECT+INSERT; pg:
   * `INSERT … ON CONFLICT DO NOTHING RETURNING`). Single-threaded stores
   * satisfy it by keeping the whole read-check-write synchronous.
   *
   * Emits the same `job:submitted` event as `insert` when it inserts, and no
   * event when it dedupes.
   */
  insertIfAbsent(job: Job): Promise<Job>
  /**
   * Unconditional patch of an existing row. Throws JOB_NOT_FOUND if `id`
   * doesn't exist.
   *
   * Conformance requirement: judge every write with
   * `nextJobState(prevStatus, nextStatus)` and emit the JobEvent type it
   * returns. That function is the state machine — which moves are legal
   * (a terminal row never moves again; nothing goes back to 'queued') and
   * which lifecycle event each legal move produces — and @orchestral/core
   * exports it precisely so a durable store does not re-derive either half
   * from prose. A refusal is a caller bug, not a no-op: throw
   * JOB_STORE_ILLEGAL_TRANSITION and leave the row AND the subscribers
   * untouched. A store that quietly writes done -> running emits a
   * `job:started` after `job:completed`, which no subscriber can tell apart
   * from a job that is genuinely running again.
   *
   * A patch that does not change the status is an output / metadata write
   * rather than a lifecycle move: legal on any row, terminal included, and
   * surfaced as 'job:output'. `job:progress` is the runtime's, fed by real
   * provider fractions — never a store's to emit.
   */
  update(id: string, patch: Partial<Job>): Promise<void>
  /**
   * Status-guarded update: applies `patch` only if the job's current status
   * still equals `ifStatus`. Returns true when the write happened, false when
   * the guard did not match (the job already moved to another status). Throws
   * JOB_NOT_FOUND if `id` doesn't exist.
   *
   * This is the atomic primitive that closes the cancel race — a single guarded
   * write replaces a read-check-write sequence, so a job that settles
   * concurrently can never be clobbered by a late cancel. Host implementations
   * back it with `UPDATE … WHERE status = ?` (a single transaction) and report
   * the boolean from `changes` (sqlite) / `rowCount` (pg).
   */
  conditionalUpdate(id: string, patch: Partial<Job>, ifStatus: JobStatus): Promise<boolean>
  get(id: string): Promise<Job | null>
  /**
   * Layer-1 idempotency lookup. Returns an existing job whose
   * idempotencyKey matches AND whose status indicates the prior run is
   * canonical (`queued / running / done`). Failed / cancelled / stale rows
   * do NOT dedupe so the caller can retry after explicit failure.
   */
  findByIdempotencyKey(key: string): Promise<Job | null>
  query(filter?: JobQueryFilter): Promise<readonly Job[]>
  /**
   * Optional store-level event stream. Runtime layers its per-job
   * subscriber list on top; stores that don't implement this just signal
   * "no store-side fanout" and the runtime falls back to in-memory broadcast.
   */
  subscribe?(callback: (event: JobEvent) => void): Unsubscribe
}
