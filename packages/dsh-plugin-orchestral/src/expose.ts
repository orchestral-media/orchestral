// Pattern → dsh tool descriptor projection.
//
// Two decisions live here and nowhere else:
//   1. WHICH Patterns a dsh agent may see — `resolveExposure` (core) is the
//      only legal way to read `Pattern.exposure`; string comparison against
//      'tool' / 'agent-tool' is a bug (the object form exists).
//   2. WHAT the model sees for each — the LLM-facing ToolDescriptor lives at a
//      kind-dependent place on the Pattern (atomic/agent: `primary.tool`,
//      meta: `tool`), mirroring @orchestral/core's own buildAlwaysLoadDescriptors.
//
// Nothing here touches dsh types, so the selection rules are unit-testable
// without a Cordis context.
import { resolveExposure, type Pattern } from '@orchestral/core'
import { z } from 'zod'

/**
 * Which dsh catalog a Pattern is being projected into.
 *
 * dsh registers tools into one registry that a main agent and its subagents
 * both draw from, so the host picks which orchestral surface that registry
 * corresponds to. `chatTurn` (the default) is the conservative reading: it
 * admits `exposure: 'tool'` Patterns only. `agentLoop` additionally admits
 * `'agent-tool'` Patterns — composition primitives an author deliberately hid
 * from a top-level turn — and is appropriate when the bundle is mounted into
 * a scoped subagent context.
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
function llmFacingTool(
  pattern: Pattern,
): { description: string; inputs: unknown } | undefined {
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
 * Select the Patterns a dsh agent may call and project each into a tool
 * descriptor.
 *
 * Ordering is the registry's own iteration order, which is registration order —
 * stable for a given host wiring, which keeps the assembled tool prefix
 * byte-stable across turns (prompt-cache friendly).
 */
export function buildPatternToolDescriptors(
  patterns: Iterable<Pattern>,
  opts: { surface: ExposureSurface; toolNamePrefix: string },
): PatternToolDescriptor[] {
  const out: PatternToolDescriptor[] = []
  for (const pattern of patterns) {
    // The ONLY correct way to read exposure — handles the string shorthand and
    // the per-surface object form, and fails closed on unnamed surfaces.
    if (!resolveExposure(pattern.exposure)[opts.surface]) continue

    const tool = llmFacingTool(pattern)
    if (!tool) continue

    out.push({
      name: toToolName(opts.toolNamePrefix, pattern.id),
      patternId: pattern.id,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputs as z.ZodTypeAny, {
        target: 'draft-2020-12',
      }) as Record<string, unknown>,
    })
  }
  return out
}
