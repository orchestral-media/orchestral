// find_pattern — the catalog discovery primitive.
//
// LLM emits `find_pattern({query, kind?, modality?})`; host calls
// handleFindPattern, returns top-K Pattern descriptors + schemas as
// structured JSON. LLM then emits `dispatch_pattern({pattern_id, ...})`
// in a follow-up turn.
//
// The input contract (`FindPatternInputSchema` / `FindPatternInput`) stays in
// @orchestral/core next to `DispatchPatternInputSchema` — rendering the tool
// definition and validating an incoming call are contract work. This module
// owns the retrieval that answers a validated call.
//
// Invariants this function preserves:
//   • catalog tool definitions never change (find_pattern is one of the
//     fixed handful of catalog entries) — KV-cache prefix stable
//   • input_schema for individual Patterns lives in tool_result content,
//     not in tool definitions or system prompt
//   • satisfiability filter applied here so the LLM doesn't see
//     Patterns whose modelTags no provider can satisfy

import type { z } from 'zod'

import type {
  Capability,
  CapabilityRouter,
  FindPatternInput,
  Pattern,
  PatternBase,
  ResolveContext,
} from '@orchestral/core'
import { resolveExposure, toJsonSchema } from '@orchestral/core'
import type { PatternSearchIndex, PatternSearchFilter } from './pattern-search-index'
import { DEFAULT_SEARCH_K } from './pattern-search-index'

/**
 * Compact LLM-facing summary of a Pattern's outputs.
 *
 * Replaces the prior full JSON Schema render (~900-1200 bytes per Pattern)
 * with a 2-field summary. Rationale: LLM never *generates* output — it
 * receives output asynchronously in a later tool_result, where the actual
 * shape is self-describing. At find_pattern time it only needs two signals
 * to decide which Pattern to dispatch:
 *   - `modality` — drives natural-language referent ("the image / transcript
 *     I just made") and downstream chaining (which Patterns accept this kind
 *     of asset as input)
 *   - `producesAssets` — distinguishes asset-producing Patterns (text-to-image,
 *     t2v, t2s — return `assets[]` handles for later reference) from
 *     inline-output Patterns (ASR, text-generation — return text directly).
 *
 * The full ZodSchema stays in `pattern.outputs` for host-side runtime
 * validation and never reaches the LLM. dispatch_pattern.input
 * is the only schema the LLM must construct — outputs are not in that path.
 */
export interface FindPatternOutputsSummary {
  /**
   * Output modality literal. Extracted from `pattern.outputs.shape.modality`
   * (all first-party Patterns emit `modality: z.literal(...)`).
   * Falls back to undefined for legacy Patterns without the literal field.
   */
  modality?: 'text' | 'image' | 'video' | 'audio'
  /**
   * True when the Pattern produces handle-addressable assets (i.e.
   * `outputs.shape.assets` exists). False for inline-text Patterns like ASR
   * and text-generation where the text comes back in the tool_result body.
   */
  producesAssets: boolean
}

/** One Pattern match returned by find_pattern. */
export interface FindPatternMatch {
  patternId: string
  kind: 'atomic' | 'meta' | 'agent'
  /** Namespace. undefined only for legacy/third-party Patterns. */
  namespace?: string
  /**
   * Primary path descriptor. For meta Patterns the "primary" tool is the
   * Pattern's own `tool` field (meta has no primary split).
   *
   * Note: `PatternBase.description` is intentionally NOT surfaced here —
   * per its doc in @orchestral/core's `pattern.ts` it's host-engineer prose,
   * not LLM tool description. The LLM gets its selection signal from
   * `primary.toolDescription`.
   *
   * Capability sub-modes are exposed via the derived `primary.inputSchema`
   * (typed providerOptions from the resolved model) + `input.references`
   * asset slots.
   */
  primary: {
    toolDescription: string
    inputSchema: unknown
  }
  /**
   * Compact outputs summary (`{modality, producesAssets}`). See
   * {@link FindPatternOutputsSummary} for the trim rationale. Undefined when
   * the Pattern declares no outputs schema (legacy / partially-initialised).
   */
  outputs?: FindPatternOutputsSummary
}

export interface FindPatternResult {
  matches: readonly FindPatternMatch[]
  /** Echo of the query for debugging. */
  query: string
  /** Echo of applied filters. */
  filtersApplied: { kind?: string; modality?: string }
  /** When provided, indicates the satisfiability filter was applied. */
  satisfiabilityFiltered: boolean
  /**
   * How many candidates ranking/selection produced, i.e. what entered the
   * accept loop (diagnostic). Corpus-level scoping — `kind`, `includeOnly`,
   * `excludeIds` — has already been applied, but the per-candidate filters
   * have not: `modality`, exposure, host-only and satisfiability drops are all
   * still counted here and broken out in `diagnostic.droppedBy`. So
   * `totalCandidates` minus the `droppedBy` sum is the accepted count before
   * the top-K slice, not after.
   */
  totalCandidates: number
  /**
   * Populated when `matches` is empty — by the selector-empty,
   * all-candidates-filtered, or nothing-found branches, or by the
   * direct-tool override when the query targets a pattern already exposed
   * as a direct tool. Breaks down where candidates were dropped so the LLM
   * can adjust its next find_pattern call instead of being left with an
   * opaque `[]`.
   *
   * Attribution is first-match-wins in accept-loop order — modality, then
   * exposure, then host-only, then satisfiability — so the counters partition
   * the dropped set (they sum to the drop total, never double-count). A
   * candidate that would fail several filters is booked against the earliest
   * one. That order is deliberate: it puts a drop under the filter the LLM
   * can most directly act on, so `modality` absorbing a pattern that is also
   * out of exposure is the intended reading, not a mis-attribution.
   */
  diagnostic?: {
    droppedBy: {
      exposure: number
      satisfiability: number
      hostOnly: number
      /**
       * Candidates the `modality` filter rejected. Counted rather than
       * pre-filtered: "your modality filter ate them" is the single most
       * actionable thing to tell an LLM staring at an empty list.
       */
      modality: number
    }
    suggestion: string
  }
}

export interface HandleFindPatternOptions {
  /**
   * Optional capability router. When provided, atomic Patterns whose
   * primary modelTags can't be satisfied are filtered out
   * (the LLM never sees them). Meta/agent Patterns bypass this
   * check since their satisfiability is composition-time.
   */
  router?: CapabilityRouter
  /** ResolveContext for router.checkSatisfiable. */
  resolveCtx?: ResolveContext
  /**
   * Pre-scope the search corpus — typical AgentPattern usage passes
   * `loop.toolPatternIds` here so the subagent's find_pattern only
   * surfaces Patterns it's allowed to dispatch.
   */
  includeOnly?: ReadonlySet<string>
  /** Cycle-defense exclude list (e.g. visited ancestors). */
  excludeIds?: ReadonlySet<string>
  /**
   * Pattern ids already surfaced to this LLM as DIRECT tools (always-load
   * inline core). They are excluded from the search corpus by design — but a
   * zero-match result whose query actually targets one of them must say so,
   * or the LLM flails through synonym queries for a tool it already holds.
   */
  directToolIds?: ReadonlySet<string>
  /** Max matches to return. Defaults to `DEFAULT_SEARCH_K` (5). */
  k?: number
  /**
   * Which LLM audience this find_pattern call serves. Mapped to a surface
   * via resolveExposure(PatternBase.exposure):
   *   • audience='chat-turn'  → requires resolved.chatTurn
   *   • audience='agent-loop' → requires resolved.agentLoop
   * Back-compat shorthand maps as: 'no-tool' → dropped everywhere;
   * 'agent-tool' → hidden from chat-turn, visible to agent-loop;
   * 'tool' / unset → visible to both. Default 'chat-turn'.
   */
  audience?: 'chat-turn' | 'agent-loop'
  /**
   * Optional model-aware schema derivation callback.
   * When provided, find_pattern hands the closure the atomic Pattern's base
   * input schema and the closure returns the fully-merged LLM-facing schema
   * for the top-1 candidate model (the host invokes the lift/merge internally):
   *   - lifts the host-marked fields (those carrying LIFT_MARKER) to
   *     Pattern.input top-level
   *   - replaces `input.providerOptions` with a typed `z.object(remaining)`
   *     (the model's leftover provider-specific fields) so structured-output
   *     generation can fill them by name instead of guessing.
   * find_pattern just `toJsonSchema()`-es the returned schema. The lift/merge
   * function itself (`deriveLlmFacingInputSchema`) ships in @orchestral/core;
   * this package never calls it directly — the host does, behind this closure.
   *
   * **Degraded fallback**: when this callback returns `undefined` for an
   * atomic Pattern, find_pattern still surfaces the Pattern but skips the
   * providerOptions lift — the LLM-facing inputSchema reverts to the base
   * `pattern.primary.tool.inputs` shape. providerOptions is per-model
   * progressive enhancement (LLM can drive provider-specific params when
   * a curated schema exists); it is NOT a gate on whether the capability is
   * usable. The atomic stays dispatchable with model-default providerOptions.
   *
   * Why a callback and not a router call: the conversion `JsonSchema → ZodObject`
   * and the lift/merge both happen host-side; find_pattern receives the
   * already-merged ZodObject via this closure, keeping the library/host
   * boundary clean.
   */
  deriveProviderOptionsZod?: (
    patternId: string,
    baseSchema: z.ZodObject<z.ZodRawShape>,
  ) => z.ZodObject<z.ZodRawShape> | undefined
}

/**
 * Run a BM25 search + satisfiability filter and return structured Pattern
 * descriptors. Pure function — the caller is responsible for wrapping the
 * result into a tool_result block for the LLM.
 */
export function handleFindPattern(
  index: PatternSearchIndex,
  input: FindPatternInput,
  options: HandleFindPatternOptions = {},
): FindPatternResult {
  // `modality` is deliberately NOT in the corpus filter: it is applied in the
  // accept loop below so its drops land in `diagnostic.droppedBy` instead of
  // silently shrinking the candidate list. Everything else here is corpus
  // scoping the caller owns and the LLM can't act on.
  const filter: PatternSearchFilter = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(options.includeOnly ? { includeOnly: options.includeOnly } : {}),
    ...(options.excludeIds ? { excludeIds: options.excludeIds } : {}),
  }
  const k = options.k ?? DEFAULT_SEARCH_K
  const audience = options.audience ?? 'chat-turn'

  // Precise selection: before falling
  // back to BM25, recognise four deterministic selector shapes that the LLM
  // can use once it already knows which Pattern(s) it wants. These pull a
  // concrete candidate list straight from the registry (no ranking) and feed
  // it through the SAME post-rank filter loop as BM25, so exposure /
  // satisfiability / includeOnly / excludeIds / kind / modality all still
  // apply identically.
  const selector = parseSelector(index, input.query)
  // Pattern corpus is small (~20-50 entries in practice); pull the full
  // ranked list and slice K only after all post-rank filters. Earlier
  // designs used a k*3 over-fetch buffer that could exhaust before
  // exposure / satisfiability / host-only filters fired, yielding fewer
  // than K matches when matches existed.
  const raw = selector
    ? index.applyFilter(selector.candidates, filter)
    : index.search(input.query, filter, Number.POSITIVE_INFINITY)

  const accepted: FindPatternMatch[] = []
  let satisfiabilityFiltered = false
  let droppedByExposure = 0
  let droppedBySatisfiability = 0
  let droppedByHostOnly = 0
  let droppedByModality = 0
  for (const pattern of raw) {
    // Modality filter — namespace is normalized inside matchesFilter, so a
    // Pattern that never declared one still answers its inferred modality.
    if (
      input.modality &&
      !index.matchesFilter(pattern, { modality: input.modality })
    ) {
      droppedByModality++
      continue
    }
    // Exposure filter — per-surface visibility via
    // resolveExposure; back-compat with the old 'tool'/'agent-tool'/'no-tool'
    // shorthand. Audience maps to one surface:
    //   audience='chat-turn'  → require resolved.chatTurn
    //   audience='agent-loop' → require resolved.agentLoop
    // (old 'no-tool' = both false → dropped everywhere; 'agent-tool' =
    // chatTurn false / agentLoop true → hidden from chat-turn only.)
    const resolved = resolveExposure(pattern.exposure)
    const visibleToAudience =
      audience === 'agent-loop' ? resolved.agentLoop : resolved.chatTurn
    if (!visibleToAudience) {
      droppedByExposure++
      continue
    }
    // Host-only agent skip — agent Patterns without a primary tool have no
    // LLM-dispatchable schema. Surfacing them just wastes a round-trip
    // (LLM dispatches → resolveDispatchTarget returns AGENT_HOST_ONLY).
    if (pattern.kind === 'agent' && !pattern.primary) {
      droppedByHostOnly++
      continue
    }
    // Atomic Patterns must have a satisfiable primary path: satisfiability
    // is "primary tags resolve to ≥1 model".
    if (options.router && pattern.kind === 'atomic') {
      satisfiabilityFiltered = true
      if (
        !isPrimarySatisfiable(pattern, options.router, options.resolveCtx)
      ) {
        droppedBySatisfiability++
        continue
      }
    }
    // Degraded fallback: when the closure returns a merged LLM-facing schema,
    // buildMatchDescriptor serialises it directly; when it returns undefined,
    // buildMatchDescriptor falls back to the base pattern.primary.tool.inputs
    // (see getPrimaryInputSchema below — the `!mergedInputSchema` branch).
    // Either way the atomic surfaces. providerOptions is per-model fine-tuning,
    // NOT a gate on capability visibility — an earlier "drop on undefined"
    // behavior hid working capabilities whenever the top-1 model had no
    // curated schema, which is the common case for long-tail models.
    let mergedInputSchema:
      | z.ZodObject<z.ZodRawShape>
      | undefined
    if (pattern.kind === 'atomic' && options.deriveProviderOptionsZod) {
      mergedInputSchema = options.deriveProviderOptionsZod(
        pattern.id,
        pattern.primary.tool.inputs as z.ZodObject<z.ZodRawShape>,
      )
    }
    accepted.push(buildMatchDescriptor(pattern, mergedInputSchema))
  }
  const matches = accepted.slice(0, k)

  const result: FindPatternResult = {
    matches,
    query: input.query,
    filtersApplied: {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.modality ? { modality: input.modality } : {}),
    },
    satisfiabilityFiltered,
    totalCandidates: raw.length,
  }
  // Selector path with no resolved candidates (e.g. `select:<unknown id>`,
  // empty prefix group): surface a diagnostic that names what failed to
  // resolve, in the same shape as the BM25 "all dropped" diagnostic, so the
  // LLM gets actionable feedback instead of an opaque `[]`.
  if (selector && selector.candidates.length === 0) {
    result.diagnostic = {
      droppedBy: { exposure: 0, satisfiability: 0, hostOnly: 0, modality: 0 },
      suggestion: selector.emptySuggestion,
    }
  } else if (matches.length === 0 && raw.length > 0) {
    const dropFragments: string[] = []
    if (droppedByModality > 0) {
      dropFragments.push(
        `${droppedByModality} are not in the "${input.modality}" modality`,
      )
    }
    if (droppedByExposure > 0) {
      dropFragments.push(
        `${droppedByExposure} hidden from this audience (exposure filter)`,
      )
    }
    if (droppedBySatisfiability > 0) {
      dropFragments.push(
        `${droppedBySatisfiability} have no model that satisfies their tags`,
      )
    }
    if (droppedByHostOnly > 0) {
      dropFragments.push(`${droppedByHostOnly} are host-only agent Patterns`)
    }
    result.diagnostic = {
      droppedBy: {
        exposure: droppedByExposure,
        satisfiability: droppedBySatisfiability,
        hostOnly: droppedByHostOnly,
        modality: droppedByModality,
      },
      suggestion:
        dropFragments.length > 0
          ? `${raw.length} candidate${raw.length === 1 ? '' : 's'} matched the BM25 query but were all filtered: ${dropFragments.join('; ')}. Try a broader query, drop the modality/kind filter, or try without filters.`
          : 'Try a broader query — your terms may not match any Pattern description.',
    }
  } else if (matches.length === 0 && raw.length === 0) {
    result.diagnostic = {
      droppedBy: {
        exposure: 0,
        satisfiability: 0,
        hostOnly: 0,
        modality: 0,
      },
      suggestion:
        'No Patterns matched the query. Try different terms, broader phrasing, or omit kind/modality filters.',
    }
  }
  // Direct-tool override: a zero-match query that was really aiming at a
  // pattern the caller already exposes as a DIRECT tool (excluded from the
  // search corpus by design) gets an explicit pointer instead of the generic
  // no-match advice — covers all three empty paths above, including the
  // selector one (`select:<direct-tool-id>` flails identically).
  if (
    matches.length === 0 &&
    options.directToolIds &&
    options.directToolIds.size > 0
  ) {
    const hit = findDirectToolHit(index, input.query, options.directToolIds)
    if (hit) {
      result.diagnostic = {
        droppedBy: result.diagnostic?.droppedBy ?? {
          exposure: 0,
          satisfiability: 0,
          hostOnly: 0,
          modality: 0,
        },
        suggestion: `"${hit}" is already available to you as a direct tool — call it directly instead of searching for it.`,
      }
    }
  }
  return result
}

/**
 * A resolved precise-selection request. `candidates` is the
 * concrete, un-ranked Pattern list the selector resolved from the registry;
 * `emptySuggestion` is the diagnostic to surface when that list is empty
 * (e.g. every `select:` id failed to resolve, or a prefix matched nothing).
 */
interface SelectorResult {
  candidates: readonly Pattern[]
  emptySuggestion: string
}

/**
 * Parse a find_pattern query into a precise selector, or return `null` to let
 * the caller fall back to BM25. Recognised shapes (checked in order):
 *
 *   1. `select:<id>[,<id>...]`  — explicit direct selection. Each token is
 *      resolved by full id first, then by short name. Listed order preserved,
 *      duplicates collapsed. Unresolved ids are reported in the diagnostic.
 *   2. `namespace:<ns>` / `namespace:<ns>:*` — the whole namespace.
 *   3. `<prefix>*` — every id starting with `<prefix>` (the `*` is a literal
 *      trailing wildcard, not a glob — `meta_*` ⇒ ids starting `meta_`).
 *   4. bare `<id>` / `<short-name>` — a single-token query that exactly
 *      matches a known id or short name short-circuits to that one Pattern.
 *
 * Anything else (free-form prose, multi-word queries, `+term` operators)
 * returns `null` → BM25.
 */
function parseSelector(
  index: PatternSearchIndex,
  query: string,
): SelectorResult | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  // 1. select:<id>[,<id>...]
  if (/^select:/i.test(trimmed)) {
    const idsRaw = trimmed.slice('select:'.length)
    const tokens = idsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const candidates: Pattern[] = []
    const seen = new Set<string>()
    const unresolved: string[] = []
    for (const token of tokens) {
      const pattern = index.getById(token) ?? index.resolveShortName(token)
      if (!pattern) {
        unresolved.push(token)
        continue
      }
      if (seen.has(pattern.id)) continue
      seen.add(pattern.id)
      candidates.push(pattern)
    }
    return {
      candidates,
      emptySuggestion:
        unresolved.length > 0
          ? `select: resolved no patterns — unknown id${unresolved.length === 1 ? '' : 's'}: ${unresolved.join(', ')}. Check the id/short-name, or use a free-form query to search.`
          : 'select: had no ids to resolve. Pass at least one id, e.g. select:text-to-image.',
    }
  }

  // 2. namespace:<ns> (optionally trailing :* glob)
  const nsMatch = /^namespace:(.+)$/i.exec(trimmed)
  if (nsMatch) {
    let ns = nsMatch[1]!.trim()
    if (ns.endsWith(':*')) ns = ns.slice(0, -':*'.length).trim()
    else if (ns.endsWith('*')) ns = ns.slice(0, -1).trim()
    return {
      candidates: ns ? index.byNamespace(ns) : [],
      emptySuggestion: `No patterns in namespace "${ns}". Check the namespace name or use a free-form query.`,
    }
  }

  // 3. <prefix>* — literal trailing-wildcard id-prefix group.
  if (trimmed.endsWith('*') && !/\s/.test(trimmed)) {
    const prefix = trimmed.slice(0, -1)
    if (prefix) {
      return {
        candidates: index.byPrefix(prefix),
        emptySuggestion: `No pattern ids start with "${prefix}". Check the prefix or use a free-form query.`,
      }
    }
  }

  // 4. bare exact id / short-name short-circuit. Only a single whitespace-free
  //    token qualifies — a multi-word query is intent prose, not an id.
  if (!/\s/.test(trimmed)) {
    const exact = index.getById(trimmed) ?? index.resolveShortName(trimmed)
    if (exact) {
      return {
        candidates: [exact],
        // Unreachable in practice (we found `exact`), but keep the shape total.
        emptySuggestion: `No pattern matched "${trimmed}".`,
      }
    }
  }

  return null
}

/**
 * Satisfiability = "is the primary routable?" — the only modelTags check
 * is on the primary path.
 */
function isPrimarySatisfiable(
  pattern: Pattern,
  router: CapabilityRouter,
  ctx: ResolveContext = {},
): boolean {
  if (pattern.kind !== 'atomic') return true
  const atomic = pattern as PatternBase & {
    primary: { modelTags?: readonly string[] }
  }
  return router.checkSatisfiable(
    pattern.id as Capability,
    atomic.primary.modelTags ?? [],
    ctx,
  ).ok
}

/**
 * Project the Pattern's full outputs ZodSchema down to the two signals the
 * LLM actually needs at find_pattern time. See {@link FindPatternOutputsSummary}.
 *
 * Strategy: walk the ZodObject shape directly (cheaper + more reliable than
 * round-tripping through z.toJSONSchema). `modality` is recognised when the
 * schema has a `modality` field whose value is a `ZodLiteral` over a known
 * Modality string. `producesAssets` triggers when the shape declares an
 * `assets` field of any kind (typically `z.array(z.object({handle, assetId, ...}))`).
 *
 * Non-ZodObject outputs (rare; legacy / hand-rolled Patterns) return
 * `{producesAssets: false}` with no modality — the LLM falls back to selecting
 * via `primary.toolDescription` alone.
 */
function summariseOutputs(outputs: unknown): FindPatternOutputsSummary {
  const summary: FindPatternOutputsSummary = { producesAssets: false }
  // ZodObject exposes its fields via `.shape` (also `.def.shape` in zod v4).
  // Both are read-only views over the same map.
  const shape = (outputs as { shape?: Record<string, unknown> } | undefined)
    ?.shape
  if (!shape || typeof shape !== 'object') return summary

  const modalityField = shape['modality']
  if (modalityField && typeof modalityField === 'object') {
    const def = (modalityField as { _def?: { type?: string; values?: unknown[] } })
      ._def
    // zod v4: ZodLiteral has _def.type === 'literal' and _def.values is the
    // tuple of accepted literal values (length 1 for `z.literal('image')`).
    if (def?.type === 'literal' && Array.isArray(def.values)) {
      const v = def.values[0]
      if (v === 'text' || v === 'image' || v === 'video' || v === 'audio') {
        summary.modality = v
      }
    }
  }

  if (shape['assets'] !== undefined) {
    summary.producesAssets = true
  }
  return summary
}

function buildMatchDescriptor(
  pattern: Pattern,
  /**
   * Pre-merged LLM-facing input ZodObject for atomic Patterns. `handleFindPattern`
   * calls `deriveProviderOptionsZod(patternId, baseSchema)` once in the outer
   * loop — the host invokes the lift/merge internally and returns the merged
   * schema, which is passed here to be serialised directly. Meta/agent Patterns and
   * atomic Patterns called without the callback (or whose top model has no
   * curated schema) get `undefined` — see `getPrimaryInputSchema` below for the
   * no-lift fallback path (serialise the base schema).
   */
  mergedInputSchema?: z.ZodObject<z.ZodRawShape>,
): FindPatternMatch {
  // Serialisation goes through @orchestral/core's `toJsonSchema`, which owns
  // the draft-2020-12 target. A find_pattern result and the always-load tool
  // prefix describe the same Pattern to the same model, so a second local
  // serialiser here would be a second place for those bytes to be decided.
  // (Byte-stability itself comes from zod: the render is deterministic for a
  // given ZodSchema — property order = ZodObject shape order.)

  // The host closure returns the merged LLM-facing schema
  // (LIFTABLE fields lifted to top level + typed z.object(remaining) for
  // providerOptions). We just serialise it. Only atomic Patterns with a primary
  // path + a curated top-model schema get the merged shape; everything else
  // (meta, agent, or no-curated-schema atomics) falls back to the base inputs.
  function getPrimaryInputSchema(): unknown {
    if (pattern.kind === 'meta') {
      return toJsonSchema(pattern.tool.inputs)
    }
    if (!pattern.primary) return {}
    if (pattern.kind !== 'atomic' || !mergedInputSchema) {
      return toJsonSchema(pattern.primary.tool.inputs)
    }
    return toJsonSchema(mergedInputSchema)
  }

  // Fallback for primary.toolDescription when neither primary nor meta tool
  // declare one: previously used `pattern.description`, but that field was
  // host-engineer prose and is no longer surfaced. Empty string keeps the
  // shape stable; in practice every first-party Pattern provides a
  // tool.description (asserted by the registry at add time).
  return {
    patternId: pattern.id,
    kind: pattern.kind,
    ...(pattern.namespace ? { namespace: pattern.namespace } : {}),
    primary: {
      toolDescription:
        pattern.kind === 'meta'
          ? pattern.tool.description
          : pattern.primary?.tool.description ?? '',
      inputSchema: getPrimaryInputSchema(),
    },
    ...(pattern.outputs ? { outputs: summariseOutputs(pattern.outputs) } : {}),
  }
}

/**
 * Deterministic detection that a zero-match query was really aiming at a
 * pattern the caller already exposes as a direct tool. Exact id / short-name
 * (with select: prefixes stripped), then a space-separated-id substring check
 * ("image to image inpainting mask" ⊇ "image to image"). Deliberately NO
 * BM25 fallback: measured on real traffic it named the wrong tool on 6/7
 * unrelated prose queries via stopword matches — an imperative hint naming
 * the wrong tool (worst case: a paid generation call) costs far more than
 * the one extra find_pattern round-trip a miss costs, and flailing models
 * converge to id-shaped queries on their own.
 * DESIGN: no-bm25-direct-tool-hint
 */
function findDirectToolHit(
  index: PatternSearchIndex,
  query: string,
  direct: ReadonlySet<string>,
): string | null {
  let t = query.trim()
  if (/^select:/i.test(t)) t = t.slice('select:'.length).trim()
  if (!t) return null
  // Registry lookups are case-sensitive Map gets — try the token as
  // written first, then lowercased (canonical ids are lowercase slugs).
  const resolveDirect = (token: string): string | null => {
    const exact =
      index.getById(token) ??
      index.resolveShortName(token) ??
      index.getById(token.toLowerCase()) ??
      index.resolveShortName(token.toLowerCase())
    return exact && direct.has(exact.id) ? exact.id : null
  }
  // Comma list (`select:a,b` with the prefix already stripped, or a bare
  // `a,b`): resolve each token independently, point at the first direct hit.
  // On no hit, fall through to the single-token / substring paths below.
  if (t.includes(',')) {
    for (const token of t.split(',')) {
      const hit = resolveDirect(token.trim())
      if (hit) return hit
    }
  }
  if (!/\s/.test(t)) {
    return resolveDirect(t)
  }
  // Multi-word prose: hit only when the query literally contains a direct
  // tool id in space-separated form. Query side normalises ALL punctuation
  // to spaces (letters/digits kept, runs collapsed) so trailing "!"/"?"
  // can't defeat the padded-space check — "use image-to-image!" still
  // contains " image to image ". The id side keeps its [-_]→space rule.
  const queryText = ` ${t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
  for (const id of direct) {
    const spaced = ` ${id.toLowerCase().replace(/[-_]/g, ' ')} `
    if (queryText.includes(spaced)) return id
  }
  return null
}
