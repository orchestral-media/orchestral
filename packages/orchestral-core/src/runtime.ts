// Runtime — substrate abstraction for the orchestration runtime.
// @orchestral/runtime ships an inline (in-process) implementation;
// other substrates (e.g. a future durable engine if a real need surfaces)
// would implement this same interface.

import type { AgentDispatchEnvelope } from './agent-envelope'
import type { Job, JobSpec, JobEvent } from './job'
import type { Unsubscribe } from './job-store'

export interface Runtime {
  /**
   * Submit a job. Substrate note: the reference InlineRuntime runs the
   * dispatch to completion before this promise resolves — the returned Job
   * is already terminal, and every job event has fired by then. To observe
   * progress on an inline substrate, hook `InlineRuntimeInit.onJobCreated`
   * and subscribe there; `await submitJob(...)` then `subscribe(...)` is
   * too late. A durable substrate may instead return a queued Job.
   *
   * Terminal-on-resolve does not survive an idempotency dedup hit on any
   * substrate: when a canonical row already exists for the spec's key, that
   * row is returned as-is and may still be `queued` / `running` with a null
   * output, because the prior submit owns the dispatch. Check `status` and
   * fall back to `subscribe` / `pollJob` when you need the outcome.
   *
   * Failure is data, not a rejection. Once a job row exists, the request has
   * been accepted, and whatever happens to it from then on — a provider
   * failure, a middleware reject, a guard trip, a cancel — lands on that row
   * (`status: 'error'` with `error` populated, or `status: 'cancelled'`),
   * emits `job:failed` / `job:cancelled`, and then resolves this promise with
   * the row. Read `job.status`; a `try/catch` around this call never sees a
   * dispatch failure. The promise rejects only when no row was ever created:
   * the request itself was malformed — an unregistered patternId, an input
   * the idempotency key cannot be derived from — or the store refused the
   * INSERT. The rule: a request that could not become a job throws; a job
   * that ran and failed returns. Either way the persisted status is
   * authoritative for anything that observes jobs out of band.
   */
  submitJob<TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
  ): Promise<Job<TIn, TOut>>
  pollJob<TIn = unknown, TOut = unknown>(
    jobId: string,
  ): Promise<Job<TIn, TOut>>
  cancelJob(jobId: string, reason?: string): Promise<void>
  subscribe(jobId: string, cb: (ev: JobEvent) => void): Unsubscribe
  /**
   * On process start, give up on the jobs persisted as queued / running that
   * no live controller owns any more — the process that was running them
   * died. Each orphan is marked terminal `'stale'` and emitted as
   * `job:stale`; the work itself is gone and is never re-attached or re-run.
   * Resolves with the jobs it abandoned, in their new terminal state.
   *
   * This is abandonment with bookkeeping, on every substrate: a substrate
   * that can genuinely resume lost work should expose that as its own call
   * rather than hiding resumption behind this one, so a caller can always
   * read the returned rows as dead.
   */
  abandonOrphanedJobs(): Promise<readonly Job[]>
  /**
   * Metadata sidecar for a settled `kind: 'agent'` dispatch — tool counts,
   * usage, final text, transcript pointer. Returns undefined for a
   * non-agent job, an unknown id, or an entry the substrate has evicted.
   *
   * Optional: a substrate that does not run agent loops (or does not retain
   * the envelope) simply omits it. Callers must feature-detect.
   *
   * @alpha
   */
  getAgentEnvelope?(jobId: string): AgentDispatchEnvelope | undefined
}
