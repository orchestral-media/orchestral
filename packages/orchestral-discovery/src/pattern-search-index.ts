// Pattern catalog search index — BM25 lexical search over the Pattern
// registry, backing `find_pattern`.
//
// Why minisearch (not embeddings, not FlexSearch, not lunr):
//   • ~5KB ESM, zero runtime deps, ships first-class TypeScript types
//   • Native BM25 ranking (Anthropic's `tool_search_tool_bm25_20251119`
//     uses the same algorithm; same selection accuracy profile)
//   • Add / remove / discard semantics map 1:1 to PatternRegistry mutations
//     — index stays in lockstep without rebuild churn
//   • Pure JS, runs in main process / worker / renderer indifferently
//
// Why the default K is 5 (override per call — see DEFAULT_SEARCH_K):
//   • published retrieval studies put the sweet spot at 3-5
//   • a default of 2 measurably under-retrieves on real catalogs
//   • larger K reintroduces the catalog-bloat problem find_pattern exists
//     to solve

import MiniSearch from 'minisearch'

import type { NamespaceId, Pattern, PatternRegistry, RegistryEntry } from '@orchestral/core'
import { resolveNamespace } from '@orchestral/core'

/**
 * Default result count for both `PatternSearchIndex.search` and
 * `handleFindPattern`. One constant so the two sides can't drift; both accept
 * an explicit override.
 */
export const DEFAULT_SEARCH_K = 5

/** Search corpus row — one per Pattern, flattens LLM-facing tool prose. */
interface PatternIndexDoc {
  /** Primary key = Pattern.id, also the document id for minisearch. */
  id: string
  /** Pattern.kind, used for client-side filter (BM25 doesn't filter, post-rank). */
  kind: 'atomic' | 'meta' | 'agent'
  /**
   * Tool description (atomic.primary.tool.description / meta.tool.description /
   * agent.primary.tool.description) + assetNeeds slot names and per-slot
   * description prose. Capability sub-mode vocabulary (inpaint / IP-Adapter
   * / voice-clone / audio-synthesis / ...) flows through assetNeeds slot names
   * and descriptions — the lexical SSOT.
   */
  toolDescriptions: string
  /**
   * Author-curated BM25 hint phrase (PatternBase.searchHint). Highest boost
   * tier alongside patternIdParts — this is the most direct lever an author
   * has on retrieval accuracy. Write it in the language(s) the Pattern's
   * users will query in — the tokenizer handles ASCII words and CJK runs
   * alike (see `cjkAwareTokenize`). Optional — omitted when the author left
   * `PatternBase.searchHint` undefined; minisearch tolerates missing fields.
   */
  searchHint?: string
  /**
   * Pattern.id tokens (split on `-`/`_`, stopwords removed). High-signal
   * because pattern ids are curated; sits in the top boost tier alongside
   * `searchHint`, so a query like "image text" deterministically surfaces
   * `image-to-text`.
   */
  patternIdParts: string
}

/**
 * BM25 field boost weights. Tier 1 (5.0) = curated signal — `patternId`
 * tokens (always present) and the author's `searchHint` capability phrase.
 * Tier 2 (1.5) = LLM-facing tool prose.
 * Notably absent: `PatternBase.description`, which is host-engineer prose
 * per its doc (see pattern.ts) and intentionally excluded from BM25.
 *
 * Extracted to a named const so production telemetry can iterate weights
 * without grepping the constructor literal.
 */
const FIELD_BOOSTS = {
  patternIdParts: 5.0,
  searchHint: 5.0,
  toolDescriptions: 1.5,
} as const

/**
 * Stopwords stripped from `patternIdParts` so connectors like `image-to-text`
 * don't drag scoring noise into the curated id field. Intentionally tiny —
 * we only want to drop functional words that recur across many ids ("to",
 * "from", "with"), not semantic ones.
 *
 * Scope: this shapes the STORED `patternIdParts` text (also the haystack for
 * `+term` checks in `matchesRequiredTerms`). Term-level BM25 filtering for
 * all fields and for queries happens in `processTerm` via `BM25_STOPWORDS`
 * (a superset of this list).
 */
const PATTERN_ID_STOPWORDS: ReadonlySet<string> = new Set([
  'to',
  'from',
  'with',
  'of',
  'a',
  'an',
  'and',
  'or',
  'the',
])

/**
 * English stopwords dropped by `processTerm` at BOTH index and query time.
 * Without this, a query like "image to image inpainting mask" surfaced
 * patterns whose description merely contained "to" ("idea to multi-scene
 * video") as confident BM25 hits — misleading the dispatching LLM and
 * suppressing find_pattern's zero-match diagnostic (which only fires when
 * the ranked list is empty).
 *
 * List = Lucene's classic English stopword set + "from" (already a
 * `PATTERN_ID_STOPWORDS` member; recurs across catalog prose like "from a
 * text prompt"). English-only on purpose: CJK query terms arrive as
 * n-grams from `cjkAwareTokenize` and never collide with this set.
 */
const BM25_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
])

/**
 * Per-character CJK detector — Unified Ideographs main block (U+4E00–U+9FFF)
 * plus Extension A (U+3400–U+4DBF). Implemented via codepoint compare so the
 * source file stays plain ASCII (some toolchains choke on inline CJK literal
 * ranges in regex character classes).
 *
 * Intentionally narrow: hiragana / katakana / hangul are skipped on purpose;
 * they have intrinsic word boundaries that the default tokenizer handles.
 * Extension B+ (U+20000+, rare archaic characters) is also skipped — expand
 * the range deliberately if real corpora demand it.
 */
function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return false
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) // Extension A
  )
}

function hasCjk(text: string): boolean {
  for (const ch of text) {
    if (isCjkChar(ch)) return true
  }
  return false
}

/**
 * Lazy handle to minisearch's default tokenizer — `MiniSearch.getDefault`
 * lives on the class itself and returns the same `SPACE_OR_PUNCTUATION`
 * splitter used internally for indexing. Caching it dodges a runtime lookup
 * per call and avoids us re-encoding the massive Unicode punctuation class.
 *
 * Hard-fails at module load if `getDefault` is missing (e.g. a minisearch
 * major bump that changes the API). A construction-time crash is
 * recoverable; a silent fallback to `\s+` whitespace split would regress
 * non-English query hit rate to zero — the entire point of this module —
 * without any error surface.
 */
const defaultTokenize: (text: string) => string[] = (() => {
  const getDefault = (
    MiniSearch as unknown as {
      getDefault: (name: string) => (text: string) => string[]
    }
  ).getDefault
  if (typeof getDefault !== 'function') {
    throw new Error(
      '[PatternSearchIndex] MiniSearch.getDefault is missing — incompatible ' +
        'minisearch version. CJK tokenization relies on the default tokenizer ' +
        'as its base layer; falling back silently to a whitespace-only split ' +
        'would regress non-English query hit rate to zero.',
    )
  }
  return getDefault('tokenize')
})()

/**
 * Tokenizer used for BOTH indexing and search. minisearch reuses the
 * constructor's `tokenize` for queries when `searchOptions.tokenize` is
 * not set (verified against minisearch 7.2.0 — search falls back to the
 * indexing tokenizer when no per-call override is supplied).
 *
 * Strategy:
 *   1. Run the stock minisearch tokenizer (whitespace + Unicode punctuation
 *      split). This preserves all existing English behavior 1:1.
 *   2. For each resulting token, if it contains no CJK char, keep as-is.
 *   3. If it contains CJK runs, emit:
 *        - any non-CJK prefix / infix / suffix as its own token
 *        - per CJK run: every 2-gram (sliding) PLUS every 1-gram char
 *          (so single-character CJK queries still hit).
 *   4. Dedupe before return so n-gram explosion doesn't double-weight terms.
 *      Intentional: repeated CJK runs (e.g. "图片图片图片") collapse to one
 *      "图片" token; BM25's term-frequency saturation already provides
 *      diminishing returns for repetition, so the Set dedup costs nothing
 *      in ranking quality.
 *
 * Examples:
 *   "find images"      -> ["find", "images"]
 *   "查找图片" (CJK)    -> 2-grams + 1-gram chars of the run
 *   "image" + CJK term -> ["image", ...n-grams of CJK run]
 */
function cjkAwareTokenize(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    if (!t) return
    if (seen.has(t)) return
    seen.add(t)
    out.push(t)
  }
  // First pass: defer to minisearch's default tokenizer (preserves English).
  const baseTokens = defaultTokenize(text).filter(Boolean)
  for (const token of baseTokens) {
    if (!hasCjk(token)) {
      push(token)
      continue
    }
    // Walk the codepoints, accumulating contiguous CJK runs and emitting
    // non-CJK fragments verbatim between them.
    const chars = Array.from(token) // splits by codepoint, not UTF-16 unit
    let i = 0
    while (i < chars.length) {
      if (!isCjkChar(chars[i]!)) {
        // Collect a non-CJK fragment.
        let j = i
        while (j < chars.length && !isCjkChar(chars[j]!)) j++
        push(chars.slice(i, j).join(''))
        i = j
        continue
      }
      // Collect a CJK run.
      let j = i
      while (j < chars.length && isCjkChar(chars[j]!)) j++
      const run = chars.slice(i, j)
      // 2-gram sliding window — primary CJK signal carrier.
      if (run.length >= 2) {
        for (let k = 0; k + 2 <= run.length; k++) {
          push(run.slice(k, k + 2).join(''))
        }
      }
      // 1-gram fallback — covers single-char queries and very short runs.
      for (const ch of run) push(ch)
      i = j
    }
  }
  return out
}

export interface PatternSearchFilter {
  /** Restrict to one Pattern kind. */
  kind?: 'atomic' | 'meta' | 'agent'
  /**
   * Restrict atomic Patterns to one modality. For non-atomic Patterns this
   * field is silently ignored (meta/agent live in `meta-pipelines` /
   * `sub-agents` namespaces that don't correspond to a single modality).
   */
  modality?: 'image' | 'video' | 'audio' | 'text'
  /**
   * Restrict to this id allowlist — used by AgentPattern dispatch to scope
   * a subagent's search corpus to its `loop.toolPatternIds` whitelist.
   * Applied AFTER kind/modality filters.
   */
  includeOnly?: ReadonlySet<string>
  /**
   * Hard exclude — typical use is to drop the current Pattern from its own
   * subagent's catalog (ancestor cycle defense) and to drop `agent_*`
   * prefixes (DEFAULT_SUBAGENT_BLOCKLIST).
   */
  excludeIds?: ReadonlySet<string>
}

const MODALITY_TO_NAMESPACE: Record<
  NonNullable<PatternSearchFilter['modality']>,
  NamespaceId
> = {
  image: 'image-gen',
  video: 'video-gen',
  audio: 'audio-gen',
  text: 'text-gen',
}

/**
 * Per-pattern serialization failure record. Surfaced via
 * `PatternSearchIndex.skipped` so callers (typically `find_pattern`) can
 * include a "catalog incomplete" hint in their diagnostic instead of
 * presenting a silently partial result set.
 */
export interface SkippedPatternRecord {
  id: string
  source: 'constructor' | 'rebuild' | 'add'
  error: unknown
}

/**
 * BM25 search index over a PatternRegistry. Build once per registry,
 * call `update` whenever the registry mutates (add / remove), call
 * `search` per `find_pattern` invocation.
 */
export class PatternSearchIndex {
  private registry: PatternRegistry
  private readonly mini: MiniSearch<PatternIndexDoc>
  /** Snapshot of (id → Pattern) for fast post-rank lookup. */
  private readonly patternsById = new Map<string, Pattern>()
  /**
   * Per-instance log of patterns that failed `addInternal`. See
   * `SkippedPatternRecord`. Cleared on `rebuild()` (full re-indexing
   * implies a fresh outcome).
   */
  private _skipped: SkippedPatternRecord[] = []

  constructor(registry: PatternRegistry) {
    this.registry = registry
    this.mini = new MiniSearch<PatternIndexDoc>({
      idField: 'id',
      fields: [
        'toolDescriptions',
        'patternIdParts',
        'searchHint',
      ],
      storeFields: ['id', 'kind'],
      // CJK-aware tokenizer — extends the default whitespace+punctuation
      // split with 2-gram + 1-gram fallback for Chinese / kanji runs.
      // minisearch reuses this for both index and search; verified against
      // the 7.2.0 type signature (SearchOptions.tokenize defaults to the
      // constructor option when omitted).
      tokenize: cjkAwareTokenize,
      // Stopword-aware term processor. Like `tokenize`, minisearch reuses it
      // for queries when `searchOptions.processTerm` is not set (verified
      // against 7.2.0), so stopwords neither enter the inverted index nor
      // score as query terms — a hit can't survive on "to" alone. Lowercasing
      // replicates the default processTerm, which this replaces.
      processTerm: (term) => {
        const t = term.toLowerCase()
        return BM25_STOPWORDS.has(t) ? null : t
      },
      // Default BM25 params (k1=1.2, b=0.7) are sensible for short
      // doc-style descriptions. Search options live per-call (see search()).
      searchOptions: {
        // Field boost map extracted to `FIELD_BOOSTS` (see its doc for the
        // per-tier rationale). PatternBase.description is excluded by
        // design — host-engineer prose, not LLM-facing.
        boost: FIELD_BOOSTS,
        // fuzzy 0.2 = allow ~1 edit distance per 5 chars; helps with mild
        // typos in the LLM query without exploding recall.
        fuzzy: 0.2,
        // prefix matching catches "image" matching "image-to-image".
        prefix: true,
      },
    })
    for (const pattern of registry.values()) {
      this.addInternalSafe(pattern, 'constructor')
    }
  }

  /**
   * Resync the index against the current registry state. Cheaper than
   * recreate when only a handful of patterns changed; safe to call after
   * registry.register / registry.attachAlternative / etc.
   */
  rebuild(registry: PatternRegistry): void {
    this.registry = registry
    // minisearch has no clear-all API; recreate the internal state.
    // Acceptable because registries are append-mostly in practice (mutations
    // happen at boot, not in steady-state).
    this.mini.removeAll()
    this.patternsById.clear()
    this._skipped = []
    for (const pattern of registry.values()) {
      this.addInternalSafe(pattern, 'rebuild')
    }
  }

  add<I = unknown, O = unknown>(pattern: Pattern<I, O>): void {
    if (this.patternsById.has(pattern.id)) {
      // Idempotent update: discard + add.
      this.mini.discard(pattern.id)
    }
    this.addInternalSafe(pattern as Pattern, 'add')
  }

  remove(patternId: string): void {
    if (!this.patternsById.has(patternId)) return
    this.mini.discard(patternId)
    this.patternsById.delete(patternId)
  }

  /**
   * Search the corpus. Returns up to `k` Patterns ranked by BM25 score.
   * Filters apply post-rank (cheap — typical corpora are <100 docs and
   * minisearch returns the full ranked list, sliced by us).
   *
   * Direct-id selection (`select:<id>[,<id>...]`) does NOT live here: it is
   * intercepted upstream in find_pattern's `parseSelector` (which resolves ids
   * straight off the registry and feeds them through `applyFilter`), so any
   * query reaching `search()` is always a free-form BM25 query. The one query
   * operator that refines BM25 here:
   *   • `+term ...` — `+`-prefixed terms are mandatory: a pattern only
   *     survives if every `+term` appears with word-boundary semantics in
   *     `patternIdParts`, `searchHint`, or `toolDescriptions`. Non-`+` terms
   *     remain BM25-ranked.
   *
   * `k` caps the returned list; it defaults to `DEFAULT_SEARCH_K` (5) and is
   * the same knob `handleFindPattern`'s `options.k` feeds.
   */
  search(
    query: string,
    filter: PatternSearchFilter = {},
    k: number = DEFAULT_SEARCH_K,
  ): readonly Pattern[] {
    const trimmed = query.trim()
    if (!trimmed) return []

    // ── +term mandatory-keyword parsing ─────────────────────────────────
    // We split on whitespace (NOT the CJK tokenizer) — `+` is a query-level
    // operator that must sit at a literal word boundary. CJK +term inputs
    // are honored: the requirement check uses substring match for CJK and
    // word-boundary regex for ASCII.
    const rawTerms = trimmed.split(/\s+/).filter(Boolean)
    const requiredTerms: string[] = []
    const optionalTerms: string[] = []
    for (const t of rawTerms) {
      if (t.startsWith('+') && t.length > 1) {
        requiredTerms.push(t.slice(1))
      } else {
        optionalTerms.push(t)
      }
    }
    // Reassemble the BM25 query from the unmarked terms (strip + prefix);
    // if every term was mandatory, fall back to the de-prefixed full set so
    // BM25 still has something to rank against.
    const bm25Query =
      optionalTerms.length > 0
        ? [...optionalTerms, ...requiredTerms].join(' ')
        : requiredTerms.join(' ')
    if (!bm25Query.trim()) return []

    const hits = this.mini.search(bm25Query)
    const out: Pattern[] = []
    for (const hit of hits) {
      if (out.length >= k) break
      const pattern = this.patternsById.get(hit.id as string)
      if (!pattern) continue
      if (!this.matchesFilter(pattern, filter)) continue
      if (
        requiredTerms.length > 0 &&
        !this.matchesRequiredTerms(pattern, requiredTerms)
      ) {
        continue
      }
      out.push(pattern)
    }
    return out
  }

  /**
   * Direct registry lookup by full Pattern id (no BM25). Backs
   * find_pattern's `select:` / exact-id short-circuit so callers that hold
   * only the index can resolve a concrete id without reaching for the
   * registry.
   */
  getById(id: string): Pattern | undefined {
    return this.registry.get(id as Pattern['id'])
  }

  /**
   * Resolve an unqualified short name to its Pattern (no BM25). Mirrors
   * `PatternRegistry.resolveShortName` but returns the Pattern itself so the
   * find_pattern selector path stays index-only.
   */
  resolveShortName(short: string): Pattern | undefined {
    const id = this.registry.resolveShortName(short)
    return id ? this.registry.get(id) : undefined
  }

  /**
   * All indexed Patterns whose id starts with `prefix`. Backs find_pattern's
   * `<prefix>*` group selector (literal trailing wildcard, e.g. `meta_*`).
   * Order follows registry insertion order.
   */
  byPrefix(prefix: string): readonly Pattern[] {
    const out: Pattern[] = []
    for (const pattern of this.patternsById.values()) {
      if (pattern.id.startsWith(prefix)) out.push(pattern)
    }
    return out
  }

  /**
   * All indexed Patterns belonging to `namespace`. Delegates to the
   * registry's namespace index (the single source of truth for membership).
   * Returns only patterns the index actually holds, so a Pattern that failed
   * to index (see `skipped`) is excluded — consistent with the BM25 path.
   */
  byNamespace(namespace: string): readonly Pattern[] {
    const out: Pattern[] = []
    for (const pattern of this.registry.byNamespace(namespace as NamespaceId)) {
      if (this.patternsById.has(pattern.id)) out.push(pattern)
    }
    return out
  }

  /**
   * Apply the same post-rank filter (`kind` / `modality` / `includeOnly` /
   * `excludeIds`) the BM25 path uses, to a caller-supplied candidate list.
   * Lets the find_pattern selector path reuse the one filter implementation
   * instead of duplicating it.
   */
  applyFilter(
    patterns: readonly Pattern[],
    filter: PatternSearchFilter = {},
  ): readonly Pattern[] {
    return patterns.filter((p) => this.matchesFilter(p, filter))
  }

  /**
   * The one filter implementation, shared by the BM25 path, `applyFilter`
   * (the find_pattern selector path), and callers that need to attribute a
   * drop to a specific filter (find_pattern counts modality drops so the LLM
   * sees why its candidates vanished).
   *
   * The modality check resolves the Pattern's namespace through
   * `resolveNamespace` — the same normalization the registry indexes by.
   * Reading the bare `Pattern.namespace` field here made every Pattern that
   * relied on inference unreachable by modality.
   */
  matchesFilter(pattern: Pattern, filter: PatternSearchFilter): boolean {
    if (filter.excludeIds?.has(pattern.id)) return false
    if (filter.includeOnly && !filter.includeOnly.has(pattern.id)) return false
    if (filter.kind && pattern.kind !== filter.kind) return false
    if (filter.modality) {
      const namespaceFilter = MODALITY_TO_NAMESPACE[filter.modality]
      const ns = resolveNamespace(pattern.id, pattern.namespace)
      if (pattern.kind === 'atomic' && ns !== namespaceFilter) {
        return false
      }
    }
    return true
  }

  /**
   * Validate that every `+term` appears in the pattern's searchable text.
   *   • ASCII terms: word-boundary match (case-insensitive). Prevents
   *     `+image` from matching `imagery` while still hitting `image-to-text`
   *     (we expand the haystack to include patternIdParts which has the
   *     id chunks pre-split on `-`/`_`).
   *   • CJK terms: plain substring match — there are no word boundaries in
   *     CJK, and the tokenize-side n-grams already handle locality.
   *
   * Haystack mirrors the indexed fields (sans `PatternBase.description`
   * which is host-engineer prose and excluded from BM25 by design):
   * `patternIdParts`, `searchHint`, `toolDescriptions`.
   */
  private matchesRequiredTerms(
    pattern: Pattern,
    requiredTerms: readonly string[],
  ): boolean {
    const doc = serializeForIndex(pattern, this.registry)
    const haystack = [
      doc.patternIdParts,
      doc.searchHint,
      doc.toolDescriptions,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    for (const term of requiredTerms) {
      const t = term.toLowerCase()
      if (hasCjk(t)) {
        if (!haystack.includes(t)) return false
      } else {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i')
        if (!re.test(haystack)) return false
      }
    }
    return true
  }

  /** Convenience: total indexed pattern count (for diagnostics / tests). */
  get size(): number {
    return this.patternsById.size
  }

  /**
   * Per-instance log of patterns that failed `addInternal`. Empty under
   * normal operation; non-empty means the catalog is incomplete and
   * callers (typically `find_pattern`) should surface a "catalog
   * incomplete" diagnostic instead of presenting a silently partial
   * result set.
   */
  get skipped(): readonly SkippedPatternRecord[] {
    return this._skipped
  }

  getEntry(patternId: Pattern['id']): RegistryEntry | undefined {
    return this.registry.getEntry(patternId)
  }

  private addInternal(pattern: Pattern): void {
    const doc = serializeForIndex(pattern, this.registry)
    this.mini.add(doc)
    this.patternsById.set(pattern.id, pattern)
  }

  /**
   * Wrap addInternal in a per-pattern try/catch so a single throwing Pattern
   * factory (typically third-party plugin or an in-flight authoring bug)
   * can't poison the entire catalog. The bad Pattern is skipped —
   * find_pattern simply won't surface it; the rest of the registry stays
   * usable.
   *
   * The skip is recorded on `this._skipped` (exposed via `skipped`), which is
   * the only report channel — a library writing to the host's stdout is not
   * ours to decide. The host MUST check `.skipped` after constructing (or
   * rebuilding) the index and surface non-empty results through its own
   * logging/diagnostics, or indexing failures are invisible: the Pattern
   * simply never appears in find_pattern results.
   */
  private addInternalSafe(pattern: Pattern, source: 'constructor' | 'rebuild' | 'add'): void {
    try {
      this.addInternal(pattern)
    } catch (e) {
      const rawId = (pattern as { id?: unknown }).id ?? '<unknown>'
      this._skipped.push({ id: String(rawId), source, error: e })
    }
  }
}

function serializeForIndex(
  pattern: Pattern,
  _registry: PatternRegistry,
): PatternIndexDoc {
  const toolDescs: string[] = []
  if (pattern.kind === 'atomic' || pattern.kind === 'agent') {
    if (pattern.primary?.tool.description) {
      toolDescs.push(pattern.primary.tool.description)
    }
  }
  if (pattern.kind === 'meta') {
    toolDescs.push(pattern.tool.description)
  }
  // SSOT: assetNeeds slot names + per-slot description prose carry the
  // capability-sub-mode lexical signal (inpaint / IP-Adapter / voice-clone /
  // audio-synthesis / end-frame ...) — indexed here so queries like
  // `find_pattern({query: 'IP-Adapter'})` continue to rank correctly.
  // Each slot name and description appended verbatim to `toolDescriptions`
  // (tier-2 boost, 1.5x).
  if (pattern.assetNeeds && pattern.assetNeeds.length > 0) {
    for (const need of pattern.assetNeeds) {
      toolDescs.push(need.slot)
      if (need.description) toolDescs.push(need.description)
    }
  }
  return {
    id: pattern.id,
    kind: pattern.kind,
    toolDescriptions: toolDescs.join(' '),
    // searchHint is optional in PatternIndexDoc; only include when the
    // author actually filled it (avoids the "" sentinel coupling).
    ...(pattern.searchHint ? { searchHint: pattern.searchHint } : {}),
    patternIdParts: tokenizePatternId(pattern.id),
  }
}

/**
 * Split a Pattern.id on `-` and `_`, lowercase, drop stopwords, rejoin with
 * a space. Result is fed into minisearch as an extra high-boost field.
 *
 * Examples:
 *   "image-to-text"        -> "image text"
 *   "text-to-image"        -> "text image"
 *   "compose_with_track"   -> "compose track"
 *   "meta_image-to-image"  -> "meta image image"
 */
function tokenizePatternId(id: string): string {
  return id
    .toLowerCase()
    .split(/[-_]+/)
    .filter((part) => part.length > 0 && !PATTERN_ID_STOPWORDS.has(part))
    .join(' ')
}
