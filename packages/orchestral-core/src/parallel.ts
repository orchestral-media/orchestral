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

export const parallel: ParallelFn = Object.assign(parallelImpl, {
  allSettled: allSettledImpl,
})
