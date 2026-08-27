import { describe, expect, it } from 'vitest'

import * as api from '../index'

// Runtime-freeze gate: pin the set of *value* exports (class / function /
// const) on the public barrel. `Object.keys` does not see pure `type` /
// `interface` exports — type-level drift is caught by the api-extractor
// report instead. The value of this snapshot is catching a value export being
// added or removed without a deliberate review.
//
// Doubly so here: every name below arrived from another package, and the whole
// claim of this package is that a consumer's `validatePlan` / `planToMeta` /
// `preflightPlan` are the same functions under one import.
describe('@orchestral/plan public surface', () => {
  it('value exports are frozen', () => {
    expect(Object.keys(api).sort()).toMatchInlineSnapshot(`
      [
        "PLAN_ASSET_REF_RE",
        "PLAN_PATTERN_ID",
        "PLAN_STEP_ID_RE",
        "PLAN_TOOL_DESCRIPTION",
        "PLAN_VALUE_REF_RE",
        "PlanDagSchema",
        "PlanInvalidError",
        "PlanOutputSchema",
        "PlanRetrySchema",
        "PlanStepSchema",
        "assertPlanValid",
        "createPlanMeta",
        "formatPlanPreflight",
        "planRefine",
        "planToMeta",
        "preflightPlan",
        "runPlan",
        "validatePlan",
      ]
    `)
  })
})
