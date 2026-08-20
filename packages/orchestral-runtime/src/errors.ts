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
    // produced before it failed; preserve them onto the JobError so the parent
    // can reference the partial output in its failure tool-result.
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
    const details = {
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
 * Sentinel thrown by the afterDispatch loop so the outer catch can route
 * its `cause` through `normaliseError` with the `MIDDLEWARE_AFTER_FAILED`
 * override code — keeps the markErrored / onError-chain path centralised.
 */
export class MiddlewareAfterFailure extends Error {
  constructor(public readonly innerCause: unknown) {
    super('MIDDLEWARE_AFTER_FAILED')
  }
}
