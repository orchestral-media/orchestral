# Changelog

All notable changes to `@orchestral/discovery` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-21 — Initial public release

### Added

- **The Pattern discovery layer.** Retrieval over a `PatternRegistry`, kept out
  of `@orchestral/core` so the contract package carries no search engine and no
  dependency beyond zod. A host that never puts a `find_pattern` tool in front
  of a model never installs this.

  - `PatternSearchIndex` — BM25 (minisearch) over a `PatternRegistry`,
    indexing tool descriptions, `searchHint`, id tokens and slot vocabulary,
    with a mixed-script tokenizer so CJK queries match CJK catalog text.
    Reads the registry through its public accessors only, so the dependency
    runs one way and core never learns this package exists.
  - `handleFindPattern` — the `find_pattern` tool handler. Selector shortcuts
    (`select:<id>`, `namespace:<ns>`, `<prefix>*`, bare id) short-circuit
    ahead of BM25 and then feed the same post-rank filter loop: modality,
    per-audience exposure, host-only agents, router satisfiability. Returns
    `FindPatternResult` with a `diagnostic` breakdown when nothing survives.
  - `DEFAULT_SEARCH_K` (5) — shared by index and handler so the two cannot
    drift.
  - Types: `PatternSearchFilter`, `SkippedPatternRecord`, `FindPatternResult`,
    `FindPatternMatch`, `FindPatternOutputsSummary`,
    `HandleFindPatternOptions`.

  The `find_pattern` **wire contract** lives in `@orchestral/core` instead:
  `FindPatternInputSchema` / `FindPatternInput` sit next to
  `DispatchPatternInputSchema`, because rendering the fixed tool definition
  (`buildCatalogDescriptors`) and validating an incoming call are contract work
  that must not require a search index. This package owns only the retrieval
  that answers a validated call.
