// The same plan, revised — one step inserted, nothing else touched.
//
// This is the edit a model makes when the user asks for one more thing, and it
// is the whole reason a plan opts into `identity: 'id'`. `caption` is listed
// SECOND and reads only `$input.prompt`; it is an independent branch that
// nothing downstream consumes. Under the positional identity every shipped meta
// uses, inserting it would move `render` from step 1 to step 2 and `animate`
// from 2 to 3 — a new idempotency key for each, and two paid re-runs of work
// whose inputs did not change. Under `identity: 'id'` the key is the step's
// name, so `describe`, `render` and `animate` all still hit run 1's rows and
// exactly one model call is made for exactly one new step.
//
// The plan pattern's own id is not in a child step's key (the key is
// `{ patternId, input, assets, sessionId, stepKey }`), so registering the
// revision under a second id is enough — no scope juggling, no unregister.

import type { PatternId } from '@orchestral/core'
import { planToMeta, type PlanDag, type PlanMetaPattern } from '@orchestral/plan'

import {
  lookupFrom,
  ShortClipInputSchema,
  SHORT_CLIP_PLAN,
  type ShortClipInput,
  type ShortClipOps,
} from './pattern'

export const CAPTIONED_PATTERN_ID = 'meta_short-clip-captioned' as PatternId

/** `SHORT_CLIP_PLAN` with a `caption` step listed second and returned as text. */
export const CAPTIONED_PLAN: PlanDag = {
  description: 'Describe, caption, render and animate one short clip.',
  steps: [
    SHORT_CLIP_PLAN.steps[0] as PlanDag['steps'][number],
    {
      id: 'caption',
      pattern: 'text-generation',
      input: {
        system: 'Write one line of alt text. No preamble.',
        prompt: '$input.prompt',
      },
    },
    ...SHORT_CLIP_PLAN.steps.slice(1),
  ],
  output: {
    assets: SHORT_CLIP_PLAN.output.assets ?? [],
    values: { ...SHORT_CLIP_PLAN.output.values, caption: '$caption.text' },
  },
}

export function createCaptionedShortClip(
  ops: ShortClipOps,
): PlanMetaPattern<ShortClipInput> {
  return planToMeta<ShortClipInput>(CAPTIONED_PLAN, {
    id: CAPTIONED_PATTERN_ID,
    lookup: lookupFrom(ops),
    inputs: ShortClipInputSchema,
    exposure: 'tool',
    description: 'Describe, caption, render and animate one short clip.',
  })
}
