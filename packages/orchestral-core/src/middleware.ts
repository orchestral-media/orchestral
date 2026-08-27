// Runtime middleware for cross-cutting concerns (moderation, cache, cost
// tracking, logging, metrics). Pattern stays a pure declarative shape;
// middleware lives at the runtime layer and the host registers an ordered
// array. Mirrors the Express / Koa / Connect onion model so callers get a
// familiar mental shape.

import type { Job, JobSpec, JobError } from './job'

/**
 * Runtime middleware for cross-cutting concerns (moderation, cache, cost
 * tracking, logging, metrics). Pattern stays pure declarative; middleware
 * lives at the runtime layer, host registers an ordered array.
 *
 * Execution order:
 *   beforeDispatch (in registration order) → dispatch → afterDispatch (in REVERSE order)
 *
 * Reverse order on afterDispatch is the same convention as Express/Koa
 * onion model. The last `beforeDispatch` to run is the first
 * `afterDispatch` to see the result.
 *
 * Hooks may be async. Errors thrown in middleware abort dispatch and
 * propagate through `onError` of subsequent middleware in registration
 * order.
 */
export interface DispatchMiddleware {
  /**
   * Called after the Job row is inserted (queued) but BEFORE Router
   * resolves any model. Can:
   *   - return { kind: 'continue' } with an optionally modified spec
   *   - return { kind: 'short-circuit', output } to skip dispatch entirely
   *     (e.g. cache hit). The Job is marked done with the supplied output —
   *     after that output meets the Pattern's `outputs` schema, the same gate
   *     an adapter's return passes. A cache entry the schema rejects fails the
   *     job with OUTPUT_SCHEMA_MISMATCH instead of standing in for a dispatch.
   *     `afterDispatch` does not run on this path: there was no dispatch.
   *   - return { kind: 'reject', code, message } to reject the request
   *     before any provider is touched (e.g. content moderation).
   *
   * Returning undefined is equivalent to { kind: 'continue', spec: <unchanged> }.
   */
  beforeDispatch?(
    spec: JobSpec,
  ): Promise<DispatchDecision | undefined> | DispatchDecision | undefined

  /**
   * Called after model.call returns successfully and BEFORE the Job row is
   * updated to status='done'. Receives the resolved output; may transform
   * it (return the new output). Returning undefined leaves the output
   * unchanged.
   *
   * Use cases: output moderation, PII scrubbing, metadata enrichment
   * (cost), result post-processing.
   */
  afterDispatch?(job: Job, output: unknown): Promise<unknown> | unknown

  /**
   * Called when dispatch fails (Router exhausted, model.call rejected,
   * alternative chain failed). Receives the Job and final JobError.
   * Cannot recover; pure observation. Use for logging / metrics.
   */
  onError?(job: Job, error: JobError): Promise<void> | void
}

export type DispatchDecision =
  | { kind: 'continue'; spec?: JobSpec }
  | { kind: 'short-circuit'; output: unknown }
  | { kind: 'reject'; code: string; message: string }
