// Schema serialization helper — one-way zod → JSON Schema conversion.
//
// Patterns are authored in zod throughout (the mainstream choice, consistent
// with the ai-sdk default):
//   • PatternBase primary.tool.inputs / outputs: ZodSchema (internal zod-native)
//   • library-internal logic is all zod ops (.parse / .safeParse /
//     z.intersection / z.infer)
//
// The only boundary requirement is the **outbound LLM / process wire format**
// (the LLM only understands JSON Schema, and zod can't cross a process
// boundary). `toJsonSchema(zod)` is the explicit outbound helper:
//   • the catalog builder / find_pattern handler, when emitting LLM-facing schema
//   • a host serializing its own injected tool descriptors across that boundary
//
// Design tradeoffs:
//   • No raw JsonSchema authoring (YAGNI — no users actually want it; adding
//     ensureZod + a json-schema-to-zod dep later is a ~30 min change)
//   • No Schema interface abstraction (over-engineering — zod-native ops are
//     faster directly)
//   • Lossiness only in the one-way zod → jsonschema direction, and it's
//     well-defined (z.toJSONSchema is a zod v4 native deterministic
//     conversion). `.refine` / `.transform` can't be expressed in JSON Schema,
//     which matches the reality of LLM tool specs (the LLM reads the schema
//     description; runtime validation lives in the host/provider).
// DESIGN: zod-only-authoring

import { z, type ZodType } from 'zod'

import type { JsonSchema } from './capability-model'

/**
 * Emit byte-stable JSON Schema for LLM-facing surfaces. Wraps zod v4 native
 * `z.toJSONSchema` with the standard `draft-2020-12` target that the catalog
 * byte-stability invariant requires.
 *
 * Use at the wire boundary:
 *   • LLM tool_result content (find_pattern, dispatch_pattern handlers)
 *   • a cross-process payload carrying host-injected agent tools
 *   • persistence to a database row / JSON snapshot file
 */
export function toJsonSchema<T>(zodSchema: ZodType<T>): JsonSchema {
  return z.toJSONSchema(zodSchema, { target: 'draft-2020-12' }) as JsonSchema
}

/** Internal. True for a JSON object, which every schema node toJsonSchema emits is. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Internal. The `anyOf` / `oneOf` / `allOf` branches directly under a rendered
 * node — a union's members, an intersection's parts. Each constrains the same
 * value the node does, so a walk over what a value may hold visits them at the
 * node's own position, and recurses for a combinator nested inside one. The
 * one reading of combinators, shared by the outputs audit (auditOutputsSchema)
 * and the reserved-input-key check (placeReserved), so the two cannot disagree
 * about what counts as a branch.
 */
export function combinatorBranches(node: Record<string, unknown>): Record<string, unknown>[] {
  const branches: Record<string, unknown>[] = []
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const listed = node[key]
    if (Array.isArray(listed)) branches.push(...listed.filter(isPlainObject))
  }
  return branches
}
