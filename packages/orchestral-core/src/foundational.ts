// Foundational ids and shared placeholders for the Pattern DSL.
// Naming convention: id is `@scope/name`; package semver carries the version.

// PatternId === Capability literal. No scope prefix.
// HuggingFace `pipeline_tag` style: 'text-to-image' / 'image-to-image' / ...
//
// PatternId is narrowed by kind:
//   • AtomicPatternId  = Capability literal (bare HF naming)
//   • MetaPatternId    = `meta_${string}` prefix
//   • AgentPatternId   = `agent_${string}` prefix
// Underscore rather than colon: the Anthropic/OpenAI tool name regex
// `[a-zA-Z0-9_-]` disallows colons — underscore lets the internal id double as
// the LLM tool name with zero encoding.
//
// The union narrow is in place. Capability's `(string & {})` open-extension
// keeps the union structurally ≡ string, so call sites are unaffected — the
// value of narrowing is that on `switch (pattern.kind)` TS can narrow the id
// type and the types serve as documentation for the reader.
import type { Capability } from './capability'

export type AtomicPatternId = Capability // 'text-to-image' / 'image-to-image' / ... + (string & {})
export type MetaPatternId = `meta_${string}` // e.g. 'meta_image-to-image-via-caption'
/**
 * e.g. 'agent_director'. The `agent_` prefix is NORMATIVE, not cosmetic: the
 * sub-agent recursion guard (`DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes` in
 * [catalog.ts](./catalog.ts)) blocks by id prefix, and `inferNamespace` routes
 * by it too. An agent Pattern id without the prefix compiles only through
 * `Capability`'s `(string & {})` tail and silently loses both — it stays
 * visible inside another agent's catalog and can recurse.
 */
export type AgentPatternId = `agent_${string}`
export type PatternId = AtomicPatternId | MetaPatternId | AgentPatternId

// Re-export of zod v4's ZodType under the legacy name so existing call sites
// keep compiling. Earlier versions defined a structural duck-type here so OSS
// could stay zod-major-agnostic, but the package now depends on zod ^4.3.6
// directly (see package.json) — there's no reason to lose the full v4 type
// surface (.parse, .safeParse, .extend, .merge, .pick, .omit, …) behind a
// hand-rolled subset, and zod v4 dropped the `_output: T` phantom field the
// old interface relied on for inference. Pattern authors should keep using
// real zod schemas; downstream code can use `z.infer<typeof schema>` for
// output inference instead of the deprecated `['_output']` accessor.
import type { z } from 'zod'

export type ZodSchema<T = unknown> = z.ZodType<T>
