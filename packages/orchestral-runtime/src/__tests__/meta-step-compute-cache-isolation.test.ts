// ctx.step and ctx.compute must not share a cache slot.
//
// Both derive their key the same way (`${stepIdNamespace}/${id}`) and both went
// through one `runWithRetry` that read and wrote one `stepCache`. Only ctx.step
// joins the `stepIds` dedup set, so a compute id was not a "duplicate" for a
// later step of the same name: the step passed the DUPLICATE_STEP_ID guard and
// then returned the compute value straight out of the cache — no dispatch, no
// job:step event, no error.
//
// The fix keeps ctx.step out of the cache entirely, which also stops its writes
// (unreadable, because the stepIds guard rejects any repeat before the cache is
// consulted) from evicting live compute entries.

import { describe, expect, it } from 'vitest'

import type { Job, JobSpec, PatternId, PatternRef } from '@orchestral/core'

import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
} from '../meta-execution-context'

function makeCtx(deps: MetaCtxDeps, state = makeFreshState()) {
  const spec = {
    patternId: 'meta_iso' as PatternId,
    input: {},
  } as JobSpec<unknown>
  const ctx = buildMetaExecutionContext(
    deps,
    'meta_iso' as PatternId,
    'job-iso',
    spec,
    new AbortController().signal,
    new Set<PatternId>(),
    state,
  )
  return { ctx, state }
}

describe('ctx.step / ctx.compute cache isolation', () => {
  it('a step does not inherit a compute result that happens to share its id', async () => {
    const dispatched: PatternId[] = []
    const { ctx } = makeCtx({
      submitChild: async (s: JobSpec<unknown>) => {
        dispatched.push(s.patternId)
        return { id: 'child-1', status: 'done', output: { from: 'dispatch' } } as unknown as Job
      },
    } as unknown as MetaCtxDeps)

    const computed = await ctx.compute('seg-0', async () => ({ from: 'compute' }))
    expect(computed).toEqual({ from: 'compute' })

    const stepped = await ctx.step(
      { patternId: 'text-generation' as PatternId, input: {} } as PatternRef,
      { stepId: 'seg-0' },
    )

    // The step really dispatched instead of silently answering from the
    // compute entry.
    expect(dispatched).toEqual(['text-generation'])
    expect(stepped).toEqual({ from: 'dispatch' })
  })

  it('a step writes nothing to the cache, so it cannot evict compute entries', async () => {
    const { ctx, state } = makeCtx({
      submitChild: async () => ({
        id: 'child-1',
        status: 'done',
        output: { ok: true },
      }),
    } as unknown as MetaCtxDeps)

    await ctx.compute('keep-me', async () => 1)
    for (let i = 0; i < 5; i++) {
      await ctx.step(
        { patternId: 'text-generation' as PatternId, input: {} } as PatternRef,
        { stepId: `s-${i}` },
      )
    }

    expect([...state.stepCache.keys()]).toEqual(['keep-me'])
  })

  it('ctx.compute still short-circuits a repeated id', async () => {
    let calls = 0
    const { ctx } = makeCtx({
      submitChild: async () => {
        throw new Error('not used')
      },
    } as unknown as MetaCtxDeps)

    const first = await ctx.compute('once', async () => {
      calls++
      return calls
    })
    const second = await ctx.compute('once', async () => {
      calls++
      return calls
    })

    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(calls).toBe(1)
  })

  it('a repeated stepId is still a hard error, not a cache hit', async () => {
    const { ctx } = makeCtx({
      submitChild: async () => ({
        id: 'child-1',
        status: 'done',
        output: { ok: true },
      }),
    } as unknown as MetaCtxDeps)

    const ref = {
      patternId: 'text-generation' as PatternId,
      input: {},
    } as PatternRef
    await ctx.step(ref, { stepId: 'dup' })
    await expect(ctx.step(ref, { stepId: 'dup' })).rejects.toThrow(
      /DUPLICATE_STEP_ID/,
    )
  })
})
