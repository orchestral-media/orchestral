import type { PatternId, ZodSchema } from './foundational'
import type { Pattern } from './pattern'
import type { Alternative } from './alternative'
import type { Unsubscribe } from './job-store'
import type { NamespaceId } from './catalog'
import { resolveNamespace } from './catalog'
import { DEFAULT_AGENT_FINISH_SPEC, defaultAgentFinishOutputs } from './agent-finish'
import { auditOutputsSchema } from './output-fields'

/**
 * In-memory pattern lookup. Host code registers concrete Pattern instances
 * at startup; runtime + planner pull from here by id or short name.
 *
 * Pattern : Capability = 1:1 — `Registry.get(capability as PatternId)`
 * is the canonical capability lookup.
 *
 * Pattern.id === Capability literal (no scope prefix). Short names are
 * identical to patternId; the `shortName` helper only strips a `/`-separated
 * prefix if one accidentally appears.
 *
 * The registry is the single source of truth for alternatives. Interface:
 *   • `add(spec)`            — the single registration entry point, auto-expands
 *                              spec.alternatives into attach calls
 *   • `getEntry(id)`         — returns the Pattern itself + all attachments
 *                              (built-in + third-party)
 *   • `attachAlternative()`  — third party attaches an alternative; gated by
 *                              Pattern.extensible
 *   • `byNamespace()`        — catalog rendering grouped by namespace
 *
 * The older interface (`register` / `get` / `has` / `resolveShortName` /
 * `listForCatalog`) is retained with unchanged behavior.
 */
export class PatternRegistry {
  private readonly byId = new Map<PatternId, Pattern>()
  private readonly byShortName = new Map<string, PatternId>()
  private readonly byNamespaceMap = new Map<NamespaceId, Set<PatternId>>()
  // Source of truth for alternatives (replaces reading the Pattern.alternatives
  // field; after the dispatch switchover the Pattern field is only a spec-sugar
  // entry point — actual runtime data is read entirely from here).
  private readonly alternativesByParentId = new Map<
    PatternId,
    Alternative<unknown, unknown>[]
  >()

  /**
   * Register a pattern under its declared id. Duplicate ids throw to
   * surface accidental double-registration at boot.
   */
  register<I = unknown, O = unknown>(
    pattern: Pattern<I, O> & { alternatives?: readonly Alternative<I, O>[] },
  ): void {
    // Authoring sugar handled here too: a factory output carrying
    // `alternatives` registered via register() must behave exactly like
    // add() — strip the field off the stored Pattern, expand each entry
    // into an attachment. Silently dropping the declared fallbacks was the
    // trap this closes.
    const sugar = (
      pattern as { alternatives?: readonly Alternative<unknown, unknown>[] }
    ).alternatives
    if (sugar !== undefined) {
      const { alternatives: _stripped, ...rest } = pattern as Pattern & {
        alternatives?: readonly Alternative<unknown, unknown>[]
      }
      this.register(rest as Pattern<I, O>)
      for (const alt of sugar) {
        this.attachAlternativeInternal(pattern.id, alt)
      }
      return
    }
    if (this.byId.has(pattern.id)) {
      throw new Error(
        `PATTERN_ALREADY_REGISTERED: ${pattern.id} — call unregister first if intentional`,
      )
    }
    const dn = shortNameOf(pattern.id)
    const existing = this.byShortName.get(dn)
    if (existing !== undefined && existing !== pattern.id) {
      throw new Error(
        `PATTERN_SHORTNAME_CONFLICT: "${dn}" already mapped to ${existing} (cannot register ${pattern.id})`,
      )
    }
    // Registry-time defence: asyncToolPatternIds must be a
    // subset of toolPatternIds. The runtime (dispatchAgent) also asserts this,
    // but catching it at register-time makes author typos fail at boot rather
    // than at first async dispatch.
    if (pattern.kind === 'agent') {
      const tools = pattern.loop.toolPatternIds
      const asyncAllow = pattern.loop.asyncToolPatternIds
      if (asyncAllow && asyncAllow.length > 0) {
        const orphans = asyncAllow.filter((id) => !tools.includes(id))
        if (orphans.length > 0) {
          throw new Error(
            `ASYNC_TOOL_PATTERN_ID_NOT_IN_TOOL_LIST: ${pattern.id} declared ` +
              `loop.asyncToolPatternIds containing ids not in loop.toolPatternIds: ` +
              `[${orphans.join(', ')}]. asyncToolPatternIds must be a subset ` +
              `of toolPatternIds.`,
          )
        }
      }
      // Finish contract: finish and loop.outputExtractor are two mutually
      // exclusive ways to produce outputs; either requires an outputs schema
      // for its result to validate against. When the author declares none of
      // the three, backfill the default trio so nothing can drift.
      const extractor = pattern.loop.outputExtractor
      if (pattern.finish && extractor) {
        throw new Error(
          `AGENT_FINISH_EXTRACTOR_CONFLICT: ${pattern.id} declares both ` +
            `finish and loop.outputExtractor — pick one finish mechanism.`,
        )
      }
      if (pattern.finish && !pattern.outputs) {
        throw new Error(
          `AGENT_FINISH_REQUIRES_OUTPUTS: ${pattern.id} declares finish but ` +
            `no outputs schema for compose's result to be validated against.`,
        )
      }
      if (extractor && !pattern.outputs) {
        throw new Error(
          `AGENT_EXTRACTOR_REQUIRES_OUTPUTS: ${pattern.id} declares ` +
            `loop.outputExtractor but no outputs schema to parse its result.`,
        )
      }
      if (!extractor && !pattern.finish && pattern.outputs) {
        throw new Error(
          `AGENT_OUTPUTS_REQUIRES_FINISH: ${pattern.id} declares custom ` +
            `outputs but no finish contract — nothing can produce that shape. ` +
            `Declare finish, or drop outputs to use the default envelope.`,
        )
      }
      if (!extractor && !pattern.finish) {
        // Backfill the default trio — the author wrote nothing, nothing can
        // drift. The default outputs shape can't fit the caller's generic `O`
        // (which is unconstrained precisely because the author declared no
        // outputs), so this erases through `unknown` — same erasure the
        // registry already performs at `byId.set(..., pattern as Pattern)`.
        pattern = {
          ...pattern,
          finish: DEFAULT_AGENT_FINISH_SPEC,
          outputs: defaultAgentFinishOutputs,
        } as unknown as typeof pattern
      }
    }
    // Registration-time authoring lint (warn-only): flag any unbounded
    // z.string() in this pattern's outputs schema so authors adopt the bounded
    // vocabulary (output-fields.ts) and raw blobs stay out of model context.
    // Deliberately non-fatal — a throw here would break existing
    // under-specified patterns at registration; the warning names the
    // offending field paths instead. Runs after the agent backfill so the
    // default finish envelope is audited too.
    const outputs = (pattern as { outputs?: ZodSchema }).outputs
    if (outputs) {
      const audit = auditOutputsSchema(outputs)
      // The deliberate exception to "the library writes nothing to stdout/stderr":
      // this is a one-shot authoring lint on the registration path, addressed to
      // the developer wiring patterns up, not to a runtime code path a host ships
      // in a request loop. Anything on a per-call path stays silent.
      if (audit.unbounded.length > 0) {
        console.warn(
          `[patterns] OUTPUTS_UNBOUNDED_FIELDS (${pattern.id}): ${audit.unbounded.join(', ')}`,
        )
      }
      // `unbounded: []` alone is not a proof of boundedness — record values,
      // $refs and unknown()/any() fields are opaque to the walk. Surface them
      // so the author knows the audit did not cover those paths.
      if (audit.notTraversed.length > 0) {
        console.warn(
          `[patterns] OUTPUTS_UNAUDITED_FIELDS (${pattern.id}): ${audit.notTraversed.join(', ')}`,
        )
      }
    }
    this.byId.set(pattern.id, pattern as Pattern)
    this.byShortName.set(dn, pattern.id)
    // namespace index — resolveNamespace is the shared normalization; the
    // search index's modality filter reads the same one.
    const ns = resolveNamespace(
      pattern.id,
      (pattern as { namespace?: NamespaceId }).namespace,
    )
    let set = this.byNamespaceMap.get(ns)
    if (!set) {
      set = new Set()
      this.byNamespaceMap.set(ns, set)
    }
    set.add(pattern.id)
  }

  /**
   * Spec-shaped registration entry point.
   *
   * The Pattern author passes in the spec their factory produced, and the
   * registry automatically:
   *   1. calls `register(pattern)` to register the Pattern itself
   *   2. attaches each spec.alternatives entry to this Pattern
   *   3. routes the attach through the same internal attachAlternative entry,
   *      fully equivalent to a third-party attachment
   *
   * The extensible field does **not** affect the sugar bundled with add()
   * (that's the Pattern's own declaration, clear author intent); extensible
   * only governs whether later external `attachAlternative` calls are allowed.
   */
  add<I = unknown, O = unknown>(
    spec: Pattern<I, O> & {
      alternatives?: readonly Alternative<I, O>[]
    },
  ): void {
    this.register(spec)
  }

  unregister(id: PatternId): boolean {
    const pattern = this.byId.get(id)
    if (!pattern) return false
    const dn = shortNameOf(pattern.id)
    if (this.byShortName.get(dn) === id) {
      this.byShortName.delete(dn)
    }
    const ns = resolveNamespace(
      pattern.id,
      (pattern as { namespace?: NamespaceId }).namespace,
    )
    this.byNamespaceMap.get(ns)?.delete(id)
    this.alternativesByParentId.delete(id)
    return this.byId.delete(id)
  }

  get(id: PatternId): Pattern | undefined {
    return this.byId.get(id)
  }

  /**
   * Get the Pattern itself + all attachments (built-in + third-party). The
   * dispatch path switched to this and no longer reads `pattern.alternatives`
   * directly.
   */
  getEntry(id: PatternId): RegistryEntry | undefined {
    const pattern = this.byId.get(id)
    if (!pattern) return undefined
    return {
      pattern,
      alternatives: this.alternativesByParentId.get(id) ?? EMPTY_ALTERNATIVES,
    }
  }

  has(id: PatternId): boolean {
    return this.byId.has(id)
  }

  /**
   * Resolve an unqualified short name (e.g. `text-to-image`) to a
   * fully-qualified patternId.
   */
  resolveShortName(short: string): PatternId | undefined {
    return this.byShortName.get(short)
  }

  /**
   * Third party attaches one alternative. Requires the parent Pattern to have
   * declared `extensible: true`, otherwise throws `PATTERN_NOT_EXTENSIBLE`.
   * Returns an Unsubscribe to undo it.
   *
   * Uses the same internal storage as the sugar bundled with add() — once
   * registered, dispatch sees no distinction between "built-in" and
   * "third-party".
   */
  attachAlternative<I, O>(
    parentId: PatternId,
    alt: Alternative<I, O>,
  ): Unsubscribe {
    const pattern = this.byId.get(parentId)
    if (!pattern) {
      throw new Error(`PATTERN_NOT_FOUND: ${parentId}`)
    }
    const extensible = (pattern as { extensible?: boolean }).extensible
    if (extensible !== true) {
      throw new Error(
        `PATTERN_NOT_EXTENSIBLE: ${parentId} does not declare extensible: true; ` +
          `cannot attach external alternative ${alt.id}`,
      )
    }
    // Variance: the public interface is narrow (<I,O> supplied by the caller),
    // while internally we store an unknown-typed list. The difference is
    // meaningless from the runtime's view — dispatch bridges the schema via
    // via.mapInput / mapOutput, so erasing the types to unknown is safe.
    return this.attachAlternativeInternal(
      parentId,
      alt as Alternative<unknown, unknown>,
    )
  }

  /**
   * Get the Pattern list for a namespace. Membership is normalized through
   * `resolveNamespace`, so a Pattern that declared no namespace is reachable
   * under its inferred one. Backs catalog rendering grouped by namespace and
   * the search index's `namespace:` selector.
   */
  byNamespace(ns: NamespaceId): readonly Pattern[] {
    const ids = this.byNamespaceMap.get(ns)
    if (!ids) return EMPTY_PATTERNS
    const out: Pattern[] = []
    for (const id of ids) {
      const p = this.byId.get(id)
      if (p) out.push(p)
    }
    return out
  }

  /**
   * Lightweight snapshot for inspection / debug surfaces. Catalog
   * rendering for LLM consumption lives in `catalog-builder.ts`
   * (`buildCatalogDescriptors`) + `pattern-search-index.ts`
   * (`PatternSearchIndex`).
   */
  listForCatalog(
    excludeIds?: readonly PatternId[],
  ): Array<{
    patternId: PatternId
    shortName: string
    description: string
    /**
     * Primary tool description — the LLM-facing description for the main
     * path. Useful for debug listings that don't need the full tool spec.
     */
    primaryDescription: string
    primaryInputs: ZodSchema<unknown>
  }> {
    const exclude = excludeIds ? new Set<PatternId>(excludeIds) : undefined
    const out: Array<{
      patternId: PatternId
      shortName: string
      description: string
      primaryDescription: string
      primaryInputs: ZodSchema<unknown>
    }> = []
    for (const p of this.byId.values()) {
      if (p.kind !== 'atomic') continue
      if (exclude?.has(p.id)) continue
      out.push({
        patternId: p.id,
        shortName: shortNameOf(p.id),
        description: p.description,
        primaryDescription: p.primary.tool.description,
        primaryInputs: p.primary.tool.inputs as ZodSchema<unknown>,
      })
    }
    return out
  }

  [Symbol.iterator](): IterableIterator<Pattern> {
    return this.byId.values()
  }

  values(): IterableIterator<Pattern> {
    return this.byId.values()
  }

  size(): number {
    return this.byId.size
  }

  // Internal helper: attach that skips the extensible check. Shared by add()
  // (built-in sugar) and attachAlternative (external) for the source-of-truth
  // write.
  private attachAlternativeInternal(
    parentId: PatternId,
    alt: Alternative<unknown, unknown>,
  ): Unsubscribe {
    let list = this.alternativesByParentId.get(parentId)
    if (!list) {
      list = []
      this.alternativesByParentId.set(parentId, list)
    }
    list.push(alt)
    return () => {
      const cur = this.alternativesByParentId.get(parentId)
      if (!cur) return
      const idx = cur.indexOf(alt)
      if (idx >= 0) cur.splice(idx, 1)
    }
  }
}

/**
 * The merged view returned by registry.getEntry(): the Pattern itself + all
 * attachments. The dispatch path reads only this, drawing no distinction
 * between "Pattern built-in" and "third-party attached".
 */
export interface RegistryEntry {
  pattern: Pattern
  alternatives: readonly Alternative<unknown, unknown>[]
}

const EMPTY_ALTERNATIVES: readonly Alternative<unknown, unknown>[] = []
const EMPTY_PATTERNS: readonly Pattern[] = []

function shortNameOf(patternId: PatternId): string {
  const idx = patternId.lastIndexOf('/')
  return idx === -1 ? patternId : patternId.slice(idx + 1)
}
