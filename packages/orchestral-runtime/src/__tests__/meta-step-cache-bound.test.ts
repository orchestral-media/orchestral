// stepCache eviction bound — the per-dispatch-tree step cache must not grow
// without limit. A meta that loops over many scenes (idea2video fanning
// meta_script2video per scene, each running several ctx.compute steps) can mint
// far more cache entries than a normal run; the cap evicts the oldest on
// overflow so one pathological run can't grow the map unbounded.
//
// Driven through the public ctx.compute, which writes the cache via the same
// runWithRetry path ctx.step uses — so this pins the eviction at the real write
// site, not a faked map.

import { describe, expect, it } from 'vitest'

import type { JobSpec, PatternId } from '@orchestral/core'

import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
} from '../meta-execution-context'

const MAX_STEP_CACHE = 512

function makeCtx(state = makeFreshState()) {
  const deps: MetaCtxDeps = {
    // Never reached — this suite only exercises ctx.compute.
    submitChild: async () => {
      throw new Error('submitChild not used in this test')
    },
  }
  const spec = { patternId: 'meta_cache_demo' as PatternId, input: {} } as JobSpec<unknown>
  const ctx = buildMetaExecutionContext(
    deps,
    'meta_cache_demo' as PatternId,
    'job-cache',
    spec,
    new AbortController().signal,
    new Set<PatternId>(),
    state,
  )
  return { ctx, state }
}

describe('stepCache eviction bound', () => {
  it('caps the cache at MAX_STEP_CACHE, evicting the oldest entries on overflow', async () => {
    const { ctx, state } = makeCtx()

    // Run more distinct compute steps than the cap — each gets a unique id, so
    // every call writes a fresh cache entry (no dedup hit).
    const total = MAX_STEP_CACHE + 50
    for (let i = 0; i < total; i++) {
      await ctx.compute(`step-${i}`, async () => i)
    }

    // The map never exceeds the cap — overflow evicted the oldest insertions.
    expect(state.stepCache.size).toBe(MAX_STEP_CACHE)

    // The oldest keys were evicted; the most-recent MAX_STEP_CACHE survive.
    expect(state.stepCache.has('step-0')).toBe(false)
    expect(state.stepCache.has(`step-${total - 1}`)).toBe(true)
    expect(state.stepCache.has(`step-${total - MAX_STEP_CACHE}`)).toBe(true)
  })

  it('does not evict while under the cap — a normal run keeps every step', async () => {
    const { ctx, state } = makeCtx()

    for (let i = 0; i < 10; i++) {
      await ctx.compute(`s-${i}`, async () => i)
    }

    expect(state.stepCache.size).toBe(10)
    expect(state.stepCache.has('s-0')).toBe(true)
    expect(state.stepCache.has('s-9')).toBe(true)
  })
})
