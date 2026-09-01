// Fan-out helper for MetaPattern.compose().
//
// Default fast-fail (`Promise.all` semantics): any rejection aborts the
// batch. `parallel.allSettled` sugar wraps `Promise.allSettled` for the
// minority of callers willing to tolerate partial failure (e.g. "3 alt
// providers, ≥1 must succeed").
//
// Nested parallel is supported by virtue of returning a Promise that
// itself can be passed to another parallel.

export interface ParallelFn {
  <T extends readonly unknown[] | []>(
    promises: T,
  ): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>
  allSettled<T extends readonly unknown[] | []>(
    promises: T,
  ): Promise<{
    -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>>
  }>
  /**
   * Fan out with an upper bound on how many run at once.
   *
   * Takes THUNKS, not promises — and that is the whole point rather than an
   * inconvenience. A promise is already running by the time it is a value, so
   * `parallel([...])` cannot throttle anything: the calls it is handed have all
   * been made. Deferring each call behind a `() =>` is what makes "at most N in
   * flight" expressible at all.
   *
   * Failure behaves like `Promise.all`, which is what the un-capped form is:
   * the first rejection rejects, no further task is STARTED, and tasks already
   * in flight are left to settle rather than cancelled — a dispatch that has
   * reached a provider is work that will be paid for either way, so abandoning
   * its result would only throw away something already bought.
   *
   * Results come back in task order, never settle order.
   *
   * The tuple typing of `parallel` is deliberately not carried over: a batch
   * worth capping is a fan-out of one kind of work, and a heterogeneous pair
   * that wants destructuring never needed a cap.
   *
   * @param concurrency Maximum simultaneous tasks; `Infinity` for no cap, in
   * which case every task is invoked SYNCHRONOUSLY and in list order, exactly
   * as a bare `Promise.all` over eagerly-built promises would have. Callers
   * whose tasks advance a shared counter at call time depend on that (see the
   * plan interpreter's level loop); a finite cap necessarily gives it up,
   * because a capped task starts when an earlier one settles.
   */
  limit<T>(
    tasks: readonly (() => Promise<T>)[],
    concurrency: number,
  ): Promise<T[]>
}

const parallelImpl = <T extends readonly unknown[] | []>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> =>
  Promise.all(promises) as Promise<{
    -readonly [K in keyof T]: Awaited<T[K]>
  }>

const allSettledImpl = <T extends readonly unknown[] | []>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }> =>
  Promise.allSettled(promises) as Promise<{
    -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>>
  }>

/**
 * Not `async`: the body has to run to completion synchronously so that, with no
 * effective cap, every task is entered before control returns to the caller.
 * An `async` wrapper would still do that (an async body runs to its first
 * await), but only by accident of where the awaits happen to sit; a plain
 * function makes it a property of the code rather than of the reader's care.
 */
const limitImpl = <T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> => {
  // `>= 1` rather than `< 1`, so NaN — which fails every comparison — lands
  // here too instead of spawning zero workers and resolving an array of holes.
  if (!(concurrency >= 1)) {
    throw Object.assign(
      new Error(
        `PARALLEL_LIMIT_INVALID: concurrency must be at least 1, got ${concurrency}`,
      ),
      { code: 'PARALLEL_LIMIT_INVALID' },
    )
  }
  const results = new Array<T>(tasks.length)
  let next = 0
  // Stops workers from claiming further tasks once one has rejected. The
  // rejection itself is delivered by Promise.all below; this only governs what
  // is still allowed to START, which is the half a caller can still control.
  let failed = false

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++
      if (index >= tasks.length) return
      const task = tasks[index]
      // A hole, not a task. `new Array(n)` never filled, or a `.filter()` over
      // a sparse source, both land here — and skipping it resolves an array
      // with a hole where a result should be. The caller then reads
      // `undefined` for work that was never attempted, which is indistinguisha-
      // ble from work that returned nothing: a dispatch silently not made,
      // reported as a batch that succeeded. Same family as
      // PARALLEL_LIMIT_INVALID above, and refused for the same reason — the
      // shape of the call is wrong before any task has run.
      if (task === undefined) {
        // Set like a rejection, because it is one: no sibling worker should
        // start further work for a batch that is already going to reject.
        failed = true
        throw Object.assign(
          new Error(
            `PARALLEL_TASK_MISSING: tasks[${index}] is not a function; a hole in ` +
              'the task list would resolve as a hole in the results.',
          ),
          { code: 'PARALLEL_TASK_MISSING' },
        )
      }
      try {
        results[index] = await task()
      } catch (err) {
        failed = true
        throw err
      }
    }
  }

  // Spawned in a synchronous loop, and each worker's body runs synchronously up
  // to its first `await task()` — so worker k has already invoked task k by the
  // time this loop ends. With `concurrency >= tasks.length` that is every task,
  // in order.
  const workers: Promise<void>[] = []
  const width = Math.min(concurrency, tasks.length)
  for (let i = 0; i < width; i++) workers.push(worker())

  return Promise.all(workers).then(() => results)
}

export const parallel: ParallelFn = Object.assign(parallelImpl, {
  allSettled: allSettledImpl,
  limit: limitImpl,
})
