// Error normalisation at the dispatch boundary. Everything a job can fail
// with — a provider Error, a thrown object, a bare string — becomes one
// `JobError` shape here, so the store, the subscription stream and the
// middleware onError chain all read failures the same way.

import type { JobError } from '@orchestral/core'

export function normaliseError(err: unknown, defaultCode?: string): JobError {
  if (err instanceof Error) {
    const code =
      (err as { code?: string }).code ?? defaultCode ?? 'DISPATCH_EXECUTE_FAILED'
    // A dispatchAgent whole-run failure throws an Error carrying the assetIds
    // produced before it failed; preserve them onto the JobError so the host
    // can salvage that partial output. A parent agent's model never sees these
    // ids — agent-dispatch translates them into its own context's handles
    // before they reach a tool-result.
    const produced = (err as { producedAssets?: readonly string[] }).producedAssets
    // Structured failure facts stamped upstream (the host gateway attaches
    // httpStatus from the wire; the dispatch loop stamps failedModel; the
    // capability router attaches `diagnostic` to ModelExcludedError with the
    // requiredTags and surviving candidates behind an unhonoured model pin).
    // Lifted into details so hosts classify invalid-input (4xx) vs transient,
    // derive retry exclusion sets, and explain a routing miss — all without
    // regexing the message.
    const httpStatus = (err as { httpStatus?: number }).httpStatus
    const failedModel = (err as { failedModel?: string }).failedModel
    const diagnostic = (err as { diagnostic?: unknown }).diagnostic
    // A throw that already carries a structured `details` object — the output
    // gate's `{ patternId, kind, issues, rawOutput }` — contributes it whole,
    // so a new coded throw does not need a new lifted key here to reach
    // `JobError.details`. The three named facts layer on top: a stamped
    // `failedModel` is never hidden by a `details` that happens to lack one.
    const stamped = (err as { details?: unknown }).details
    const details = {
      ...(typeof stamped === 'object' && stamped !== null ? stamped : {}),
      ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
      ...(typeof failedModel === 'string' ? { failedModel } : {}),
      ...(typeof diagnostic === 'object' && diagnostic !== null ? { diagnostic } : {}),
    }
    return {
      code,
      message: err.message,
      cause: err,
      ...(Object.keys(details).length ? { details } : {}),
      ...(produced?.length ? { producedAssets: produced } : {}),
    }
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return {
        code: defaultCode ?? 'UNKNOWN',
        message: JSON.stringify(err),
        details: err,
      }
    } catch {
      return {
        code: defaultCode ?? 'UNKNOWN',
        message: '[unserialisable error]',
      }
    }
  }
  return { code: defaultCode ?? 'UNKNOWN', message: String(err) }
}

/**
 * The one way this package throws CANCELLED.
 *
 * `normaliseError` reads `.code` and nothing else, and CANCELLED is the code
 * carrying the most weight in the runtime: `CHILD_FAILURE_RETHROWN_CODES` uses
 * it to decide whether a failed child kills an agent loop or comes back as a
 * tool result. A bare Error whose message is only the word CANCELLED says the
 * code in prose alone, so it normalises to DISPATCH_EXECUTE_FAILED — and a
 * host cancelling one child job directly (the parent's signal never aborts)
 * had its cancel handed to the model as a retryable tool failure.
 *
 * `detail` is the site, not the code: the message reads `CANCELLED: <detail>`
 * so a host reading `JobError.message` learns WHERE the abort was noticed,
 * while it still narrows on `JobError.code`.
 */
export function cancelledError(detail: string): Error {
  return Object.assign(new Error(`CANCELLED: ${detail}`), { code: 'CANCELLED' })
}

/**
 * Sentinel thrown by the afterDispatch loop so the outer catch can route
 * its `cause` through `normaliseError` with the `MIDDLEWARE_AFTER_FAILED`
 * override code — keeps the markErrored / onError-chain path centralised.
 */
export class MiddlewareAfterFailure extends Error {
  constructor(public readonly innerCause: unknown) {
    super('MIDDLEWARE_AFTER_FAILED')
  }
}
