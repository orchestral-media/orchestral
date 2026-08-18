import { describe, expect, it } from 'vitest'

import * as api from '../index'

// Phase 4 runtime-freeze gate: pin the set of *value* exports (class /
// function / const) on the public barrel. `Object.keys` does not see pure
// `type` / `interface` exports — type-level drift is caught by Phase 5's
// api-extractor instead. The value of this snapshot is catching a value
// export being added or removed without a deliberate review.
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
