// DispatchMiddleware 错误分支回归 (inline.ts beforeDispatch / afterDispatch /
// onError)。submit-agent-async.test.ts 只覆盖了 beforeDispatch 的 short-circuit
// 顺路;三条错误分支此前零覆盖:
//
//   1. beforeDispatch throw → runOnErrorChain 从 i+1 起跑(抛错的那个 hook 不
//      观测自己的失败),再 markErrored + rethrow。  (inline.ts:606-623)
//   2. afterDispatch throw → 包成 MiddlewareAfterFailure,outer catch 据此把
//      错误码覆盖成 MIDDLEWARE_AFTER_FAILED。              (inline.ts:696-708,727-733)
//   3. onError 隔离 → 一个 onError 抛错只 console.error,不阻塞后续 onError。
//      (inline.ts:753-769)
//
// 把 i+1 改成 i、漏掉 MiddlewareAfterFailure 包裹、或 onError 不 try/catch 都
// 是静默回归,会破坏依赖一致错误事件的缓存失效 / 审核 / 成本统计中间件。

import { describe, expect, it, vi } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  DispatchMiddleware,
  Job,
  JobError,
  ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'
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

function makeRuntime(middleware: readonly DispatchMiddleware[]): InlineRuntime {
  const registry = new PatternRegistry()
  registry.add(makeInstantPattern() as never)
  return new InlineRuntime({
    router: makeInstantRouter(),
    registry,
    store: new MemoryJobStore() as never,
    middleware,
  })
}

function submit(runtime: InlineRuntime): Promise<unknown> {
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

    await expect(submit(runtime)).rejects.toThrow('mw0 failed')
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

    // The inner cause surfaces as the rejection; the normalised error code that
    // onError observes is overridden to MIDDLEWARE_AFTER_FAILED.
    await expect(submit(runtime)).rejects.toThrow('cache write failed')
    expect(onErrorCodes).toContain('MIDDLEWARE_AFTER_FAILED')
  })

  it('onError isolation: a throwing onError does not block the next handler', async () => {
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

    const runtime = makeRuntime([mw0, mw1])

    await expect(submit(runtime)).rejects.toThrow('trigger')
    // mw1.onError fired despite mw0.onError throwing — the throw was isolated.
    expect(fired).toEqual([1])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
