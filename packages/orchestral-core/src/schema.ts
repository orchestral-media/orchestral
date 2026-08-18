// Schema serialization helper — one-way zod → JSON Schema conversion.
//
// OSS Patterns are authored in zod throughout (the mainstream choice,
// consistent with the ai-sdk default):
//   • PatternBase primary.tool.inputs / outputs: ZodSchema (internal zod-native)
//   • OSS internal logic is all zod ops (.parse / .safeParse / z.intersection /
//     z.infer)
//
// The only boundary requirement is the **outbound LLM / IPC wire format** (the
// LLM only understands JSON Schema, and zod can't cross IPC). `toJsonSchema(zod)`
// is the explicit outbound helper the host calls when serializing:
//   • host tool descriptor: called by serializeHostTool
//   • OSS catalog-builder / find_pattern handler: when emitting LLM-facing schema
//   • host AgentRunImpl wrapping host-injected agent tools across IPC
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

import { z, type ZodType } from 'zod'

import type { JsonSchema } from './capability-model'

/**
 * Emit byte-stable JSON Schema for LLM-facing surfaces. Wraps zod v4 native
 * `z.toJSONSchema` with the standard `draft-2020-12` target that the catalog
 * byte-stability invariant requires.
 *
 * Use at the wire boundary:
 *   • LLM tool_result content(find_pattern, dispatch_pattern handlers)
 *   • IPC payload to worker(host AgentRunImpl wrap host-injected agent tools)
 *   • Persistence to sqlite / JSON snapshot file
 */
export function toJsonSchema<T>(zodSchema: ZodType<T>): JsonSchema {
  return z.toJSONSchema(zodSchema, { target: 'draft-2020-12' }) as JsonSchema
}
