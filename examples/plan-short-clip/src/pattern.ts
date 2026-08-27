// meta_short-clip — the SAME three-step pipeline examples/incremental-rerun
// hand-writes as a `compose()`, here as data.
//
//   describe   text-generation   $input.prompt → one line of shot direction
//   render     text-to-image     $describe.text → a still (returns assets[])
//   animate    image-to-video    $input.motion + $render.assets[0] → a clip
//
// Nothing in this file is a framework. `short-clip.plan.json` is the whole
// pipeline; `planToMeta` walks it with the registry in hand and dispatches each
// step through `ctx.step`, so the pattern this factory returns is an ordinary
// `MetaPattern` — validated before spend, content-addressed per step,
// cancellable, observable, and dispatched by exactly the same runtime code as a
// hand-written one. `origin: 'plan'` records where it came from; nothing gates
// on it.
//
// The one thing a plan does that the hand-written meta does not: every step
// dispatches with `identity: 'id'`, so its durable JobStore row is keyed by the
// step's NAME rather than by its position in the compose run. That is what
// `plan-captioned.ts`'s inserted step leans on.

import type { Pattern, PatternId } from '@orchestral/core'
import { planToMeta, type PlanDag, type PlanMetaPattern } from '@orchestral/plan'
import { z } from 'zod'

import planJson from './short-clip.plan.json' with { type: 'json' }

export const SHORT_CLIP_PATTERN_ID = 'meta_short-clip' as PatternId

/**
 * The persisted DAG, exactly as it sits on disk. Typed rather than parsed: the
 * JSON is the source of truth, and `planToMeta` validates every rule zod cannot
 * express (grammar, ids, backward refs, output shape) at construction — so a
 * typo here is a `PlanInvalidError` from `createShortClip`, not a job that
 * fails after it has spent.
 */
export const SHORT_CLIP_PLAN = planJson as PlanDag

/**
 * The plan's own parameters. This IS the pattern's `tool.inputs`, and it is
 * what `$input.<field>` binds to inside the DAG: `$input.prompt` in `describe`,
 * `$input.motion` in `animate`. A `$input` reference to anything not declared
 * here is refused before the plan runs (`PLAN_PARAM_UNKNOWN`).
 */
export const ShortClipInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe('What the clip is of — the subject of the single shot.'),
  motion: z
    .string()
    .min(1)
    .max(500)
    .describe('How the camera moves once the still is animated.'),
})
export type ShortClipInput = z.infer<typeof ShortClipInputSchema>

/**
 * The one host operation this package's factory asks for, declared in
 * package.json as `"requiredOps": ["getPattern"]`.
 *
 * Why an op and not the registry: `compose` receives no registry, and a factory
 * loaded through `addFromManifest` receives only `ops`. `requiredOps` is the
 * mechanism that already exists for exactly this — a function the host
 * supplies, checked as `typeof ops[op] === 'function'` before the factory runs.
 */
export interface ShortClipOps {
  getPattern: (id: PatternId) => Pattern | undefined
}

/** The manifest's `export` — what `addFromManifest` calls with the host's ops. */
export function createShortClip(ops: ShortClipOps): PlanMetaPattern<ShortClipInput> {
  return planToMeta<ShortClipInput>(SHORT_CLIP_PLAN, {
    id: SHORT_CLIP_PATTERN_ID,
    lookup: lookupFrom(ops),
    inputs: ShortClipInputSchema,
    // A shipped plan package is a tool like any other pattern. The default is
    // `'no-tool'`, which is the right default for a plan built at runtime — a
    // session's plan should not become another agent loop's tool by accident.
    exposure: 'tool',
    description: 'Describe, render and animate one short clip.',
    searchHint: 'short clip from a prompt: describe, render, animate',
  })
}

/** `{ get, getEntry }` over a `getPattern` op — the shape the walk reads. */
export function lookupFrom(ops: ShortClipOps) {
  return {
    get: (id: PatternId) => ops.getPattern(id),
    getEntry: (id: PatternId) => {
      const pattern = ops.getPattern(id)
      return pattern === undefined ? undefined : { pattern, alternatives: [] }
    },
  }
}
