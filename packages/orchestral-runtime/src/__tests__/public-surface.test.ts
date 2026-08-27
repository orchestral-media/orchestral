import { describe, expect, it } from 'vitest'

import * as api from '../index'

// Runtime-freeze gate: pin the set of *value* exports (class / function /
// const) on the public barrel. `Object.keys` does not see pure `type` /
// `interface` exports — type-level drift is caught by api-extractor instead
// (`pnpm api:check`). The value of this snapshot is catching a value export
// being added or removed without a deliberate review.
//
// `preflightPlan` / `formatPlanPreflight` left this package: preflight is the
// plan feature, and the plan feature is @orchestral/plan now. Nothing here
// re-exports them — a host that preflights adds that dependency, which is the
// honest bill for the whole feature rather than a transitive surprise.
describe('@orchestral/runtime public surface', () => {
  it('value exports are frozen', () => {
    expect(Object.keys(api).sort()).toMatchInlineSnapshot(`
      [
        "IdempotencyNotSerialisableError",
        "InlineRuntime",
        "InlineRuntimeAdapter",
        "deriveIdempotencyKey",
        "forkExecutionContext",
        "resolveAssets",
      ]
    `)
  })
})
