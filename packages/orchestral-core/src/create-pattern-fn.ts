// createPatternFn — sugar layer for exporting Pattern functions.
//
// Lets Pattern authors write `await storyDevelopment(ctx, input)` instead of
// `await ctx.step({ patternId, input })`, gaining:
//   • compile-time catch of a misspelled patternId
//   • IDE autocomplete for input fields (typed via the I generic)
//   • output type inference (typed via the O generic — IDE knows result.text is a string)
//   • go-to-definition and hover docs for the Pattern
//
// Usage:
//   // In a Pattern module, export a typed function:
//   export const storyDevelopment = createPatternFn<StoryInput, StoryOutput>(
//     'text-generation'
//   )
//
//   // When an author writes meta.compose:
//   const story = await storyDevelopment(ctx, { idea: '...' })

import type { PatternId } from './foundational'
import type {
  CtxStepFn,
  ExecutionContext,
  StepOptions,
  StepResult,
} from './execution-context'
import type { PatternRef } from './pattern-ref'

/**
 * Pattern function call options. `StepOptions` (retry / metadata / stepId)
 * plus the internal-asset channel: a meta may thread already-resolved,
 * slot-keyed assetIds it produced (e.g. a prior sub-step's output) to this
 * sub-step via `assets` — the same machine-to-machine channel as
 * `PatternRef.assets`. Ambient resolution context (projectId /
 * providerOptions) still flows through `ctx`, not a per-call override.
 */
export type PatternFnOptions = StepOptions & {
  /** Internal-asset channel — see {@link PatternRef.assets}. */
  assets?: PatternRef['assets']
}

/**
 * Pattern function — typed wrapper over `ctx.step`. Day-to-day caller
 * receives plain value; `.withMeta` overload returns full `StepResult`
 * with `stepId / attempts / durationMs` for progress UI / debug.
 */
export interface PatternFn<I, O> {
  (
    ctx: ExecutionContext,
    input: I,
    options?: PatternFnOptions,
  ): Promise<O>
  withMeta(
    ctx: ExecutionContext,
    input: I,
    options?: PatternFnOptions,
  ): Promise<StepResult<O>>
  /** Underlying patternId — useful for declarative `alternatives` refs. */
  readonly patternId: PatternId
}

/**
 * Build a typed Pattern function backed by `ctx.step`. Generic args:
 *   I — sub-Pattern input type
 *   O — sub-Pattern output type
 *
 * The returned function's stepId defaults to ctx.step's auto-counter
 * (`${patternId}#${seq}`); pass `options.stepId` to override
 * for resume-stable map fan-out (`{ stepId: \`portrait-\${i}\` }`).
 */
export function createPatternFn<I = unknown, O = unknown>(
  patternId: PatternId,
): PatternFn<I, O> {
  const dispatch = async (
    ctx: ExecutionContext,
    input: I,
    options?: PatternFnOptions,
  ): Promise<O> => {
    const { assets, ...stepOptions } = options ?? {}
    const ref: PatternRef = {
      patternId,
      input,
      ...(assets ? { assets } : {}),
    }
    const step = ctx.step as CtxStepFn
    return step<O>(ref, stepOptions)
  }

  const dispatchWithMeta = async (
    ctx: ExecutionContext,
    input: I,
    options?: PatternFnOptions,
  ): Promise<StepResult<O>> => {
    const { assets, ...stepOptions } = options ?? {}
    const ref: PatternRef = {
      patternId,
      input,
      ...(assets ? { assets } : {}),
    }
    const step = ctx.step as CtxStepFn
    return step.withMeta<O>(ref, stepOptions)
  }

  const fn = Object.assign(dispatch, {
    withMeta: dispatchWithMeta,
    patternId,
  }) as PatternFn<I, O>

  return fn
}
