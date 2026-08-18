// Guards on the shared meta helpers — most importantly that one buggy
// adapter emitting a non-finite cost cannot poison every parent meta's
// aggregated envelope (the runtime does not zod-validate dispatch outputs,
// so sumCosts is the last line of defence).
import { describe, expect, it } from 'vitest'

import { sumCosts } from '../meta/_shared/meta-utils'

describe('sumCosts', () => {
  it('sums plain costs and treats missing/undefined as 0', () => {
    expect(sumCosts({ cost: 0.1 }, { cost: 0.2 }, {}, undefined)).toBeCloseTo(0.3)
  })

  it('treats NaN and Infinity as 0 instead of poisoning the aggregate', () => {
    expect(sumCosts({ cost: Number.NaN }, { cost: 0.5 })).toBeCloseTo(0.5)
    expect(
      sumCosts({ cost: Number.POSITIVE_INFINITY }, { cost: 0.25 }),
    ).toBeCloseTo(0.25)
  })

  it('ignores non-number cost values', () => {
    expect(
      sumCosts({ cost: '3' as unknown as number }, { cost: 1 }),
    ).toBe(1)
  })
})
