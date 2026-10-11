// Pattern → dsh tool descriptor projection.
//
// Three decisions live here and nowhere else:
//   1. WHICH Patterns a dsh agent may see — `resolveExposure` (core) is the
//      only legal way to read `Pattern.exposure`; string comparison against
//      'tool' / 'agent-tool' is a bug (the object form exists).
//   2. WHAT the model sees for each — the LLM-facing ToolDescriptor lives at a
//      kind-dependent place on the Pattern (atomic/agent: `primary.tool`,
//      meta: `tool`), mirroring @orchestral/core's own buildAlwaysLoadDescriptors.
//      Its JSON Schema is rendered by core's `toJsonSchema`.
//   3. WHICH FIELD is held back — the derived `name` a Pattern whose outputs
//      carry assets[] gets at registration is omitted, because this bridge
//      records no product under any name (see exposedParameters). Apart from
//      that one property, a dsh tool and an always-load catalog entry describe
//      the same Pattern byte-for-byte.
//
// Nothing here touches dsh types, so the selection rules are unit-testable
// without a Cordis context.
import {
  matchSubagentBlocklist,
  producesAssets,
  resolveExposure,
  toJsonSchema,
  type Pattern,
  type ToolDescriptor,
} from '@orchestral/core'

/**
 * Which dsh catalog a Pattern is being projected into.
 *
 * dsh registers tools into one registry that a main agent and its subagents
 * both draw from, so the host picks which orchestral surface that registry
 * corresponds to. `chatTurn` (the default) is the conservative reading: it
 * admits `exposure: 'tool'` Patterns only.
 *
 * `agentLoop` is the sub-agent catalog, and it is TWO gates, not one — the
 * same two orchestral runs when it builds a sub-agent's own catalog. It
 * additionally admits `'agent-tool'` Patterns (composition primitives an
 * author deliberately hid from a top-level turn), and it subtracts everything
 * `DEFAULT_SUBAGENT_BLOCKLIST` names — every `agent_*` Pattern. Dropping the
 * second gate would make this surface strictly wider than the one it is named
 * after: `agent_orchestrator` declares `exposure: { chatTurn: true,
 * agentLoop: true }` and would become a tool a sub-agent could call directly,
 * which is the recursion the prefix guard exists to make physically
 * impossible.
 *
 * What the bridge still cannot see is the ANCESTOR CHAIN — dsh owns the
 * sub-agent tree, and a tool registry is built once at load, not per
 * dispatch. The prefix gate is what is expressible here; a host that nests
 * orchestral agents inside dsh agents owns the rest.
 */
export type ExposureSurface = 'chatTurn' | 'agentLoop'

/** One Pattern projected into the three fields dsh's `ToolSchema` needs. */
export interface PatternToolDescriptor {
  /** dsh tool name (`toolNamePrefix` + PatternId). */
  name: string
  /** The PatternId this tool dispatches — never sent to the model. */
  patternId: string
  /** LLM-visible description, taken from the Pattern's own ToolDescriptor. */
  description: string
  /** JSON Schema for the arguments (dsh `ToolSchema.parameters`). */
  parameters: Record<string, unknown>
}

/**
 * The Pattern's LLM-facing surface, or `undefined` when it has none.
 *
 * An AgentPattern without `primary` is host-only by construction (no tool
 * spec to show a model), so it is skipped regardless of `exposure`.
 */
function llmFacingTool(pattern: Pattern): ToolDescriptor | undefined {
  if (pattern.kind === 'atomic') return pattern.primary.tool
  if (pattern.kind === 'meta') return pattern.tool
  return pattern.primary?.tool
}

/**
 * dsh tool names are model-visible identifiers. PatternIds are already
 * constrained to `[a-zA-Z0-9_-]` by design (see core/foundational.ts — the
 * underscore prefix on meta_/agent_ exists precisely so the id can double as a
 * tool name), so this only guards against a host-coined id that broke that
 * rule.
 */
function toToolName(prefix: string, patternId: string): string {
  return `${prefix}${patternId}`.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * The tool's JSON Schema as this bridge offers it.
 *
 * Registration appends the reserved, derived `name` field to the inputs of
 * every Pattern whose outputs carry `assets[]`, so that a caller can choose
 * what a product is called. This bridge records nothing to a ledger, and
 * `projectToolOutputForModel` drops every asset that has no handle, so a dsh
 * model never sees one and a `name` here could never be honoured. The honest
 * surface is not to offer the field (never advertise what is not reachable).
 *
 * `producesAssets` is the whole test: a hand-written `name` on such a Pattern
 * throws at registration, so the field present here is always the derived one.
 * It is removed from the rendered JSON rather than with zod `.omit()`, which
 * throws on a refined input. `references` stays: it is meaningful here (the
 * `resolveAssets` pass reads it). Every other byte is `toJsonSchema`'s.
 */
function exposedParameters(pattern: Pattern, tool: ToolDescriptor) {
  const schema = toJsonSchema(tool.inputs) as Record<string, unknown>
  if (!producesAssets(pattern)) return schema

  // Copy, then replace in place: assigning an existing key keeps its position,
  // so the key order (and so the serialised bytes) is `toJsonSchema`'s own.
  const out: Record<string, unknown> = { ...schema }
  const { properties, required } = schema
  if (typeof properties === 'object' && properties !== null) {
    const { name: _name, ...others } = properties as Record<string, unknown>
    out.properties = others
  }
  if (Array.isArray(required)) {
    out.required = required.filter((key) => key !== 'name')
  }
  return out
}

/**
 * Select the Patterns a dsh agent may call and project each into a tool
 * descriptor.
 *
 * Ordering is the registry's own iteration order, which is registration order —
 * stable for a given host wiring, which keeps the assembled tool prefix
 * byte-stable across turns (prompt-cache friendly).
 */
export function buildPatternToolDescriptors(
  patterns: Iterable<Pattern>,
  opts: {
    surface: ExposureSurface
    toolNamePrefix: string
    /** See `Config.exposeDeferred`. Default `false` — always-load only. */
    exposeDeferred?: boolean
  },
): PatternToolDescriptor[] {
  const out: PatternToolDescriptor[] = []
  for (const pattern of patterns) {
    // The ONLY correct way to read exposure — handles the string shorthand and
    // the per-surface object form, and fails closed on unnamed surfaces.
    if (!resolveExposure(pattern.exposure)[opts.surface]) continue

    // Gate 2, sub-agent surface only. `matchSubagentBlocklist` is core's own
    // predicate (the same one agent-dispatch routes on), so this stays one
    // decision in one place rather than a fourth hand-copied prefix test.
    if (
      opts.surface === 'agentLoop' &&
      matchSubagentBlocklist(pattern.id) !== null
    ) {
      continue
    }

    // Gate 3: the load strategy. `exposureMode` answers a different question
    // from `exposure` — not "who may see this" but "is it worth a slot in the
    // tool table". Everything here becomes a first-class dsh tool, so the
    // default mirrors core's own always-load catalog rather than flattening
    // the register into the prompt.
    if (opts.exposeDeferred !== true && pattern.exposureMode !== 'always-load') {
      continue
    }

    const tool = llmFacingTool(pattern)
    if (!tool) continue

    out.push({
      name: toToolName(opts.toolNamePrefix, pattern.id),
      patternId: pattern.id,
      description: tool.description,
      parameters: exposedParameters(pattern, tool),
    })
  }
  return out
}
