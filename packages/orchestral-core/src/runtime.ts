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
   * Failure rejects — it does not resolve with a failed Job. On the reference
   * InlineRuntime a terminal failure first persists the row (`error`, or
   * `cancelled` when the abort signal fired) and emits `job:failed` /
   * `job:cancelled`, then rethrows the underlying error; an unregistered
   * patternId rejects before any row exists at all. So a resolved Job from
   * this call is never a failed one, and the persisted status is authoritative
   * for anything that observes jobs out of band.
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
   * On process start, bring jobs persisted as queued / running back to a
   * consistent state. What "consistent" means is substrate-defined: a
   * durable engine may re-attach and resume; an in-process runtime cannot
   * resume lost work — the reference InlineRuntime marks every such job
   * terminal `'stale'` and emits `job:stale`. Callers must not assume
   * resumption: treat the returned jobs as reconciled, not recovered.
   */
  reconcile(): Promise<readonly Job[]>
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
