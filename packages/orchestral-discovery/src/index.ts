// @orchestral/discovery
// The LLM discovery layer for a Pattern catalog: a BM25 index over a
// `PatternRegistry` plus the `find_pattern` tool handler that ranks, filters
// and renders Patterns for a model to choose from.
//
// Kept out of @orchestral/core deliberately. Core is the contract — Pattern /
// ModelCapability / Alternative, the registry, the Job and Runtime interfaces.
// Which retrieval algorithm turns a free-form query into a shortlist is a
// product decision a host may want to replace (embeddings, a hosted search
// service, a hand-written router), and it drags in a search dependency core
// should not carry. The wire contract for the tool call itself
// (`FindPatternInputSchema`) stays in core next to `DispatchPatternInputSchema`.
// DESIGN: discovery-out-of-core

// ── BM25 retrieval ───────────────────────────────────────────────────────
export {
  PatternSearchIndex,
  DEFAULT_SEARCH_K,
  type PatternSearchFilter,
  // Element type of the public `PatternSearchIndex.skipped` getter — exported
  // so callers (typically find_pattern) can name what they iterate over.
  type SkippedPatternRecord,
} from './pattern-search-index'

// ── find_pattern tool handler ────────────────────────────────────────────
// Takes a validated `FindPatternInput` (schema lives in @orchestral/core) and
// returns the structured result a host wraps into a tool_result block.
export {
  handleFindPattern,
  type FindPatternResult,
  type FindPatternMatch,
  type FindPatternOutputsSummary,
  type HandleFindPatternOptions,
} from './find-pattern'

// ── The injectable seam ──────────────────────────────────────────────────
// `PatternSearch` (the contract) lives in @orchestral/core; this is the
// first-party implementation a host hands to @orchestral/runtime's
// `InlineRuntimeInit.patternSearch`. QUERY_SYNTAX_HINT is the prose half of
// the same split — the query language this package parses, for a host to
// splice into the find_pattern tool description.
export {
  createPatternSearch,
  type CreatePatternSearchOptions,
} from './create-pattern-search'
export { QUERY_SYNTAX_HINT } from './find-pattern'
