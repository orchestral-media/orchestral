// The job state machine — one function, both halves of it.
//
// Which transitions are legal, and which JobEvent a legal one produces, used
// to exist only inside InMemoryJobStore: a dev-only default implementation
// whose private switch a durable host store had to re-derive from a comment.
// Neither half is detectably wrong once a store gets it wrong — a `job:started`
// emitted after `job:completed` looks exactly like a live job to every
// subscriber, and a `done` row quietly reopened looks exactly like work still
// in flight.
//
// Pure: no store, no IO, no Job snapshot. The caller owns persistence and
// stamps its own post-transition row onto the event this hands back.

import type { Job, JobEvent, JobStatus } from './job'

/**
 * The lifecycle events a store owns. Progress / artifact / step / fallback
 * events are the runtime's — they carry provider-side facts a store never
 * sees — so they are deliberately not in this union.
 */
export type JobLifecycleEventType =
  | 'job:submitted'
  | 'job:started'
  | 'job:completed'
  | 'job:failed'
  | 'job:cancelled'
  | 'job:stale'
  | 'job:output'

// Spelled as a literal in `JobTransition` below rather than `typeof` this
// const: api-extractor treats a public type referencing a module-local
// declaration as a forgotten export (error). The two cannot drift — every
// refusal below assigns this const into that field, so a rename that misses
// one side fails to compile.
const ILLEGAL_TRANSITION = 'JOB_STORE_ILLEGAL_TRANSITION'

/**
 * `nextJobState`'s verdict on one status write: either the event the store
 * should emit, or the refusal it should throw. A result type rather than a
 * boolean because the two answers carry different facts, and rather than a
 * throw because the store — not this module — knows which row was refused.
 */
export type JobTransition =
  | { readonly ok: true; readonly event: JobLifecycleEventType }
  | {
      readonly ok: false
      readonly code: 'JOB_STORE_ILLEGAL_TRANSITION'
      /** Why the move was refused, in terms a host can put in front of a caller. */
      readonly reason: string
    }

/**
 * The statuses no further transition leaves. Reaching one of the four ends the
 * Job's lifecycle: the row can still be patched in place (see the same-status
 * rule in `nextJobState`), but its status never changes again. Exported so a
 * host store, a UI, and this module all read the same set instead of each
 * hard-coding the list.
 *
 * DESIGN: terminal-status-never-moves
 */
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  'done',
  'error',
  'cancelled',
  'stale',
] as const

const TERMINAL = new Set<JobStatus>(JOB_TERMINAL_STATUSES)

// Entering a status from a DIFFERENT one — the lifecycle moves. 'queued' has
// no entry here on purpose: a job is queued only when it is first written, and
// `nextJobState` refuses every later move into it.
const EVENT_FOR_ENTERING: Readonly<
  Record<Exclude<JobStatus, 'queued'>, JobLifecycleEventType>
> = {
  running: 'job:started',
  done: 'job:completed',
  error: 'job:failed',
  cancelled: 'job:cancelled',
  stale: 'job:stale',
}

/**
 * Judge a status write and name the event it produces. `prev === null` means
 * the row does not exist yet (an insert).
 *
 * The three rules, in the order they apply:
 *   1. First write — legal from any status (a host replaying a finished run
 *      inserts the settled row directly), reported as 'job:submitted'.
 *   2. Same status — an output / metadata patch, not a lifecycle move, so it
 *      stays legal on a terminal row too; reported as 'job:output'.
 *      'job:progress' is reserved for real provider fractions fed through
 *      CallEvents.onProgress and is never a store's to emit.
 *   3. Otherwise the move must leave a non-terminal status and must not land
 *      back on 'queued'.
 *
 * Returns a refusal rather than throwing: the store owns the throw, because it
 * is the one that knows which row was refused.
 */
export function nextJobState(prev: JobStatus | null, next: JobStatus): JobTransition {
  if (prev === null) return { ok: true, event: 'job:submitted' }
  if (prev === next) return { ok: true, event: 'job:output' }
  if (TERMINAL.has(prev)) {
    return {
      ok: false,
      code: ILLEGAL_TRANSITION,
      reason: `${prev} is terminal; a settled job never moves to ${next}`,
    }
  }
  if (next === 'queued') {
    return {
      ok: false,
      code: ILLEGAL_TRANSITION,
      reason: `${prev} -> queued is backwards; a job is queued only when it is first written`,
    }
  }
  return { ok: true, event: EVENT_FOR_ENTERING[next] }
}

/**
 * The error a store throws on a refused write. `code` follows the runtime's
 * error-code convention (normaliseError reads `.code` and nothing else);
 * `details` carries the two statuses so a host can report the refusal without
 * regexing the message.
 *
 * Module-level export for job-store-memory.ts; not re-exported from index.ts —
 * a host store throws its own error and reads the code off the refusal.
 */
export function illegalTransitionError(
  id: string,
  prev: JobStatus | null,
  next: JobStatus,
  reason: string,
): Error {
  return Object.assign(new Error(`${ILLEGAL_TRANSITION}: ${id}: ${reason}`), {
    code: ILLEGAL_TRANSITION,
    details: { jobId: id, from: prev, to: next },
  })
}

/**
 * Build the event for a legal transition. Every lifecycle event carries just
 * the post-transition snapshot, so one constructor covers all seven.
 *
 * Module-level export for job-store-memory.ts; not re-exported from index.ts.
 */
export function lifecycleEvent(type: JobLifecycleEventType, job: Job): JobEvent {
  return { type, job }
}
