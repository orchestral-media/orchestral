// DispatchMiddleware error-branch regression (beforeDispatch / afterDispatch /
// onError, all driven from inline.ts). submit-agent-async.test.ts covers the
// beforeDispatch short-circuit in passing; these three error branches had no
// coverage at all:
//
//   1. beforeDispatch throws → `runOnErrorChain` starts at i+1 (the hook that
//      raised must NOT observe its own failure), then markErrored + rethrow.
//   2. afterDispatch throws → wrapped in `MiddlewareAfterFailure` (errors.ts)
//      so the outer catch overrides the normalised code to
//      MIDDLEWARE_AFTER_FAILED while the inner cause still surfaces as the
//      rejection.
//   3. onError isolation → a throwing onError is reported through the
//      DiagnosticsLogger (never the console); it never blocks the onError
//      handlers after it.
//
// Turning the i+1 into i, dropping the MiddlewareAfterFailure wrapper, or
// losing the try/catch around onError are all SILENT regressions: they break
// cache-invalidation / audit / cost-accounting middleware that depends on a
// consistent error-event contract.

import { describe, expect, it, vi } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  DispatchMiddleware,
  Job,
  JobError,
  ModelCapability,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  type DiagnosticsLogger,
  InMemoryJobStore as MemoryJobStore,
  PatternRegistry,
} from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

// An atomic that resolves immediately, so the dispatch reaches afterDispatch.
function makeInstantRouter(): CapabilityRouter {
  const cap: ModelCapability = {
    modelId: 'fake:instant',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-instant'],
    inputs: ['text'],
    outputs: ['text'],
    source: 'user',
    async call() {
      return { output: { modality: 'text', text: 'ok' } } as unknown
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function makeInstantPattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-instant',
    kind: 'atomic',
    description: 'resolves immediately',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'instant', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

function makeRuntime(
  middleware: readonly DispatchMiddleware[],
  logger?: DiagnosticsLogger,
): InlineRuntime {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.add(makeInstantPattern() as never)
  return new InlineRuntime({
    router: makeInstantRouter(),
    registry,
    store: new MemoryJobStore() as never,
    middleware,
    ...(logger ? { logger } : {}),
  })
}

function submit(runtime: InlineRuntime): Promise<Job> {
  return runtime.submitJob({
    patternId: 'fake-instant',
    input: { prompt: 'hi' },
  } as never)
}

describe('middleware error paths', () => {
  it('beforeDispatch throw: onError fires only on SUBSEQUENT middleware (startIndex = i+1)', async () => {
    const onErrorCalls: number[] = []
    const mw0: DispatchMiddleware = {
      beforeDispatch: () => {
        throw new Error('mw0 failed')
      },
      onError: () => {
        onErrorCalls.push(0)
      },
    }
    const mw1: DispatchMiddleware = { onError: () => void onErrorCalls.push(1) }
    const mw2: DispatchMiddleware = { onError: () => void onErrorCalls.push(2) }

    const runtime = makeRuntime([mw0, mw1, mw2])

    const job = await submit(runtime)
    expect(job.status).toBe('error')
    expect(job.error?.message).toContain('mw0 failed')
    // mw0 raised the failure, so it must NOT observe its own error; the chain
    // starts at i+1 = 1 → only mw1 and mw2 fire.
    expect(onErrorCalls).toEqual([1, 2])
  })

  it('afterDispatch throw: error reaches onError with code MIDDLEWARE_AFTER_FAILED', async () => {
    const onErrorCodes: string[] = []
    const mw: DispatchMiddleware = {
      afterDispatch: () => {
        throw new Error('cache write failed')
      },
      onError: (_job: Job, err: JobError) => void onErrorCodes.push(err.code),
    }

    const runtime = makeRuntime([mw])

    // The inner cause surfaces as the JobError message; the normalised error
    // code that onError observes (and that lands on the row) is overridden to
    // MIDDLEWARE_AFTER_FAILED.
    const job = await submit(runtime)
    expect(job.status).toBe('error')
    expect(job.error?.message).toContain('cache write failed')
    expect(job.error?.code).toBe('MIDDLEWARE_AFTER_FAILED')
    expect(onErrorCodes).toContain('MIDDLEWARE_AFTER_FAILED')
  })

  it('onError isolation: a throwing onError does not block the next handler', async () => {
    // The throw is reported through the injected DiagnosticsLogger — the one
    // channel the runtime has for "a host callback threw" — never the console.
    const logged: string[] = []
    const logger: DiagnosticsLogger = {
      warn: (m) => void logged.push(`warn:${m}`),
      error: (m) => void logged.push(`error:${m}`),
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fired: number[] = []
    // afterDispatch runs in reverse order (mw1 first, then mw0), so mw0's throw
    // drives the FULL onError chain from index 0 — both onError handlers run.
    const mw0: DispatchMiddleware = {
      afterDispatch: () => {
        throw new Error('trigger')
      },
      onError: () => {
        throw new Error('onError0 also throws')
      },
    }
    const mw1: DispatchMiddleware = { onError: () => void fired.push(1) }

    const runtime = makeRuntime([mw0, mw1], logger)

    const job = await submit(runtime)
    expect(job.status).toBe('error')
    expect(job.error?.message).toContain('trigger')
    // mw1.onError fired despite mw0.onError throwing — the throw was isolated.
    expect(fired).toEqual([1])
    // …and reported: exactly one error-level diagnostic naming the onError
    // throw, and nothing on the host console.
    expect(logged.filter((l) => l.startsWith('error:') && l.includes('onError'))).toHaveLength(1)
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
