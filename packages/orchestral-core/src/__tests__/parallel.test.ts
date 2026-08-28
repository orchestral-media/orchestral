import { describe, expect, it, vi } from 'vitest'

import { parallel } from '../parallel'

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('parallel', () => {
  it('is Promise.all over already-created promises', async () => {
    expect(await parallel([Promise.resolve(1), Promise.resolve('a')])).toEqual([1, 'a'])
  })

  it('allSettled reports both outcomes', async () => {
    const settled = await parallel.allSettled([
      Promise.resolve(1),
      Promise.reject(new Error('no')),
    ])
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(settled[1]?.status).toBe('rejected')
  })
})

describe('parallel.limit', () => {
  it('returns results in input order, not settle order', async () => {
    const order: number[] = []
    const results = await parallel.limit(
      [
        async () => {
          await tick()
          await tick()
          order.push(0)
          return 'slow'
        },
        async () => {
          order.push(1)
          return 'fast'
        },
      ],
      2,
    )
    expect(results).toEqual(['slow', 'fast'])
    expect(order).toEqual([1, 0])
  })

  it('never exceeds the cap', async () => {
    let inFlight = 0
    let peak = 0
    const task = () => async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight -= 1
      return true
    }
    await parallel.limit(Array.from({ length: 12 }, task), 3)
    expect(peak).toBe(3)
  })

  // The invariant the plan interpreter's level loop depends on: a `ctx.step`
  // counter advances at CALL time, so an uncapped run has to invoke every task
  // synchronously and in list order, exactly as `level.map(...)` did.
  it('with no effective cap, invokes every task synchronously in list order', () => {
    const calls: number[] = []
    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      calls.push(i)
      await tick()
      return i
    })
    void parallel.limit(tasks, Number.POSITIVE_INFINITY)
    // No await between the call above and this assertion: every task must
    // already have been entered.
    expect(calls).toEqual([0, 1, 2, 3, 4])
  })

  it('a cap at or above the task count behaves the same way', () => {
    const calls: number[] = []
    const tasks = Array.from({ length: 3 }, (_, i) => async () => {
      calls.push(i)
      await tick()
      return i
    })
    void parallel.limit(tasks, 3)
    expect(calls).toEqual([0, 1, 2])
  })

  it('starts no further task after a rejection', async () => {
    const started: number[] = []
    const gate = deferred<never>()
    const tasks = [
      async () => {
        started.push(0)
        return gate.promise
      },
      async () => {
        started.push(1)
        await tick()
        return 1 as const
      },
      async () => {
        started.push(2)
        return 2 as const
      },
    ]
    const run = parallel.limit(tasks, 2)
    gate.reject(new Error('boom'))
    await expect(run).rejects.toThrow('boom')
    await tick()
    await tick()
    // 0 and 1 were in flight when 0 rejected; 2 was never reached.
    expect(started).toEqual([0, 1])
  })

  it('leaves an in-flight sibling to settle rather than cancelling it', async () => {
    const sibling = vi.fn()
    const run = parallel.limit(
      [
        async () => {
          throw new Error('boom')
        },
        async () => {
          await tick()
          sibling()
          return 'done'
        },
      ],
      2,
    )
    await expect(run).rejects.toThrow('boom')
    await tick()
    await tick()
    expect(sibling).toHaveBeenCalledOnce()
  })

  it('accepts an empty task list', async () => {
    expect(await parallel.limit([], 4)).toEqual([])
  })

  it('refuses a concurrency below 1', () => {
    expect(() => parallel.limit([async () => 1], 0)).toThrow(
      /PARALLEL_LIMIT_INVALID/,
    )
    expect(() => parallel.limit([async () => 1], -2)).toThrow(
      /PARALLEL_LIMIT_INVALID/,
    )
    expect(() => parallel.limit([async () => 1], Number.NaN)).toThrow(
      /PARALLEL_LIMIT_INVALID/,
    )
  })
})
