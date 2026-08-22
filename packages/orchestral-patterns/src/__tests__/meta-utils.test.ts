// Guards on the shared meta helpers — most importantly that one buggy
// adapter emitting a non-finite cost cannot poison every parent meta's
// aggregated envelope (the runtime does not zod-validate dispatch outputs,
// so sumCosts is the last line of defence), and that an adapter which did
// not report a cost (null) is never quietly summed past.
import { describe, expect, it } from 'vitest'

import { sumCosts } from '../meta/_shared/meta-utils'

describe('sumCosts', () => {
  it('sums plain costs and treats undefined as 0', () => {
    expect(sumCosts([1, 2])).toBe(3)
    expect(sumCosts([0.1, 0.2, undefined])).toBeCloseTo(0.3)
    expect(sumCosts([])).toBe(0)
  })

  it('returns null when any input is null — a partial sum reads as a confident total', () => {
    expect(sumCosts([1, null, 2])).toBeNull()
    expect(sumCosts([null])).toBeNull()
    // A sub-total that already came back null feeds straight back in.
    expect(sumCosts([sumCosts([1, null]), 5])).toBeNull()
  })

  it('treats NaN and Infinity as 0 instead of poisoning the aggregate', () => {
    expect(sumCosts([Number.NaN, 0.5])).toBeCloseTo(0.5)
    expect(sumCosts([Number.POSITIVE_INFINITY, 0.25])).toBeCloseTo(0.25)
  })

  it('ignores non-number cost values', () => {
    expect(sumCosts(['3' as unknown as number, 1])).toBe(1)
  })
})
