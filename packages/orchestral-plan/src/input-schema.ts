// The schema a plan step's input is held to, and how it is parsed — once.
//
// Both plan layers gate a step's input: `validatePlan`'s rule 21 on the literal
// the author wrote, the interpreter's layer 2 on what substitution made of it.
// Each carried its own copy of both halves — which schema a target is parsed
// against, and the top-level `.passthrough()` that lets `size` / `seed` /
// `providerOptions` / the derived `references` survive — byte-identical, each
// with a comment promising it matched the dispatch path. Two copies of one
// verdict can disagree, and when they do a plan passes layer 1 and is refused
// at layer 2 for a key it was always going to carry, after its upstream steps
// were paid for. One function each, now.
//
// What both mirror is core's dispatch path (dispatch-pattern.ts:
// `selectInputSchema`, then `resolveDispatchTarget`'s `parseSchema`): the
// dispatch a step becomes parses the same schema the same way, so neither
// layer can refuse what the dispatch would take, or take what it would refuse.
// That copy stays in core on purpose. Exporting a two-line zod shim from core's
// public surface for two internal callers here would give it an API report and
// a semver contract, to save a mirror that one test (input-schema.test.ts)
// already holds to the dispatch path's behaviour.
//
// Internal to this package — not re-exported from index.ts.

import type { Pattern } from '@orchestral/core'
import type { z } from 'zod'

/**
 * The schema a dispatch would parse this target's input against: a meta's
 * `tool.inputs`, an atomic's `primary.tool.inputs`. Undefined for a pattern
 * with no LLM-callable tool, which neither layer has a schema to hold it to.
 */
export function inputSchemaOf(target: Pattern): z.ZodType<unknown> | undefined {
  return target.kind === 'meta' ? target.tool.inputs : target.primary?.tool.inputs
}

/**
 * Top-level `.passthrough()` when the schema supports it — what the dispatch
 * path's `parseSchema` does, so a plan layer's verdict and the dispatch's
 * cannot disagree. Top-level only, as there: declared fields, nested ones
 * included, still validate. A schema with no `.passthrough()` (a union, a
 * non-object) is parsed as it is, as it is there.
 */
export function passthroughOf(schema: unknown): z.ZodType<unknown> {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    'passthrough' in schema &&
    typeof (schema as { passthrough?: unknown }).passthrough === 'function'
  ) {
    return (schema as { passthrough: () => z.ZodType<unknown> }).passthrough()
  }
  return schema as z.ZodType<unknown>
}
