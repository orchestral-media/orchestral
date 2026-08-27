// LLM tool catalog descriptor builder.
//
// Emits exactly 2 fixed router descriptors: find_pattern + dispatch_pattern.
// Host tools are prepended to this array by the host when it assembles the
// catalog (host-owned; this library knows nothing about host tool naming).
//
// Cross-process safe: descriptors are pure data (zod-to-JSON-Schema'd inputs,
// no closures), so they marshal cleanly over IPC. Worker / main / web hosts all
// consume this list and wrap each entry into an ai-sdk Tool with its own
// `execute` closure (find_pattern / dispatch_pattern run the library's handler;
// host tools are executed by the host itself).

import { z } from 'zod'

import { DispatchPatternInputSchema } from './dispatch-pattern'
import { FindPatternInputSchema } from './find-pattern-schema'
import type { Pattern } from './pattern'
import { resolveExposure } from './pattern'
import { toJsonSchema } from './schema'

// The find_pattern / dispatch_pattern schemas are owned by this package, so
// serialising them here is a self-contained internal operation (much like
// ai-sdk serialising its own Tool inputSchema) — not the host's
// responsibility. The serialiser itself is not: `toJsonSchema` is the one
// place the draft-2020-12 target lives, because these descriptors are a
// KV-cached prompt prefix and must render the same bytes as every other
// surface.

/**
 * Cross-process tool descriptor (IPC-friendly, no closures). Host wraps
 * each into an ai-sdk Tool with its own execute closure.
 */
export interface AgentToolDescriptor {
  /**
   * LLM-visible tool name. Router tools use the library's fixed names
   * (`find_pattern` / `dispatch_pattern`); host tools are named by the host,
   * which owns its own naming convention (a namespace prefix such as `base.*`
   * is common but not required here).
   */
  name: string
  /** LLM-visible description. */
  description: string
  /** JSON Schema for the tool's input. */
  inputSchema: unknown
}

/**
 * Slot-defaulting sentence spliced into the `dispatch_pattern` description.
 * It states what this library's own reference resolver does: an omitted
 * REQUIRED slot falls back to the most recent same-modality asset in the
 * context (see `resolveAssetReferences`), which is also what the derived
 * per-slot descriptions promise. Telling the model to be explicit is the
 * point — the fallback is a convenience, not a guess it should rely on.
 */
const DEFAULT_SLOT_DEFAULT_NOTE =
  'When the user means a specific asset, or several assets of the same modality are in play, pass its handle explicitly for ANY slot including the primary/source slot; if a required slot is omitted the host defaults to the most recent same-modality asset, which may not be the one the user meant.'

const DISPATCH_DESCRIPTION_HEAD =
  'Invoke a specific Pattern by id. Use find_pattern first to discover the pattern_id and its derived input schema. If input fails validation, the tool_result will include zod issues field-by-field — read them, fix the input, and retry. Assets are referenced by HANDLE via `input.references.<slot>` — never pass raw asset ids in `input`. '

const DISPATCH_DESCRIPTION_TAIL =
  ' For OPTIONAL attachments (mask / end-frame / reference / voiceClone) read the per-slot descriptions inside the schema\'s \`references\` object — unknown slot keys are rejected.'

export interface BuildCatalogDescriptorsOptions {
  /**
   * Override for the sentence describing how an omitted required asset slot
   * is resolved. Slot defaulting is implemented by this library's own
   * reference resolver, so the default text is already accurate and most
   * hosts should leave this unset. Supply it only when you have replaced the
   * resolver with one that defaults differently — or not at all — and the
   * stock sentence would therefore mislead the model.
   *
   * It is spliced verbatim into the `dispatch_pattern` description, which sits
   * in the byte-stable tool prefix — keep it constant across turns.
   */
  slotDefaultNote?: string
}

/**
 * Build the fixed router descriptors (find_pattern + dispatch_pattern).
 *
 * Host tools are not built here: the host prepends its own descriptors in its
 * catalog-assembly layer before calling this function.
 */
export function buildCatalogDescriptors(
  opts: BuildCatalogDescriptorsOptions = {},
): AgentToolDescriptor[] {
  return [
    {
      name: 'find_pattern',
      description:
        'Search the Pattern catalog. Returns top-K matching Patterns with their tool descriptions, primary input schemas (with the resolved top-1 model\'s typed providerOptions fields lifted in), a typed references object whose per-slot descriptions document required and optional asset attachments, and a compact output summary (modality + producesAssets). Use this to discover what capabilities are available for a user task. Patterns have three kinds: atomic (single capability call — image/video/audio/text generation, editing, analysis), meta (multi-step pipeline), agent (LLM-driven loop). Pass optional `kind` and (for atomic) `modality` filters to narrow the search.',
      inputSchema: toJsonSchema(FindPatternInputSchema),
    },
    {
      name: 'dispatch_pattern',
      description:
        DISPATCH_DESCRIPTION_HEAD +
        (opts.slotDefaultNote ?? DEFAULT_SLOT_DEFAULT_NOTE) +
        DISPATCH_DESCRIPTION_TAIL,
      inputSchema: toJsonSchema(DispatchPatternInputSchema),
    },
  ]
}

/**
 * Build first-class tool descriptors for Patterns opted into `exposureMode:
 * 'always-load'` AND visible on `opts.surface`. The host prepends these into
 * the chat-turn catalog so the LLM can call e.g. `text-to-image({...})` in one
 * hop, bypassing find_pattern → dispatch_pattern. Tool name === patternId, so
 * the host routes the call straight into the dispatch execution chain (no
 * `pattern_id` arg needed).
 *
 * The two fields compose in one order and only one: `exposure` decides whether
 * this surface may see the Pattern at all, `exposureMode` decides how it is
 * reached once it may. Promotion is not a way around the filter — a Pattern the
 * author hid from a surface is not promoted onto it, which is also the answer
 * find_pattern and the dsh bridge give for the same Pattern.
 *
 * Same byte-stable / IPC-safe contract as buildCatalogDescriptors (pure data,
 * no closures). When `deriveProviderOptionsZod` is supplied, it returns the
 * fully-merged LLM-facing schema for the atomic's top-1 model (the host
 * invokes the lift/merge internally) and this function just serialises it. When
 * the closure returns undefined for an atomic (no curated schema for the top-1
 * model, or no closure at all), the descriptor is still emitted with the BASE
 * inputSchema — providerOptions is progressive enhancement, not an expose
 * gate. These descriptors sit in the tool-definition prefix, so byte-stability
 * matters more than for find_pattern results — the merge's fixed field order
 * keeps the prompt cache warm.
 */
export function buildAlwaysLoadDescriptors(
  patterns: Iterable<Pattern>,
  opts: {
    deriveProviderOptionsZod?: (
      id: string,
      baseSchema: z.ZodObject<z.ZodRawShape>,
    ) => z.ZodObject<z.ZodRawShape> | undefined
    /**
     * Which LLM catalog is being assembled. Defaults to `'chatTurn'`: that is
     * this builder's stated job, and of the two LLM surfaces it is the narrower
     * one (`'agent-tool'` is agentLoop-only), so a caller that has not said
     * which catalog it is filling fails closed rather than open. The agent loop
     * says `'agentLoop'` — see buildAgentInlineCore in @orchestral/runtime.
     */
    surface?: 'chatTurn' | 'agentLoop'
  } = {},
): AgentToolDescriptor[] {
  const surface = opts.surface ?? 'chatTurn'
  const out: AgentToolDescriptor[] = []
  for (const p of patterns) {
    // Exposure first, mode second. Reading exposureMode alone was the bypass.
    // DESIGN: always-load-honours-exposure
    if (!resolveExposure(p.exposure)[surface]) continue
    if (p.exposureMode !== 'always-load') continue
    if (p.kind === 'atomic') {
      let inputs: unknown = p.primary.tool.inputs
      if (opts.deriveProviderOptionsZod) {
        // The closure returns the merged LLM-facing schema (host invokes the
        // lift). Degraded path: when no curated providerOptions schema exists
        // for the top model the closure returns undefined, and we expose the
        // atomic with its BASE inputSchema (no lift). providerOptions is a
        // per-model fine-tuning surface, NOT an expose gate. The atomic stays
        // usable with model defaults; the LLM just can't drive the
        // provider-specific params (quality/style/etc.) until the host ships or the
        // user supplies the schema.
        const merged = opts.deriveProviderOptionsZod(
          p.id,
          p.primary.tool.inputs as z.ZodObject<z.ZodRawShape>,
        )
        if (merged) inputs = merged
      }
      out.push({
        name: p.id,
        description: p.primary.tool.description,
        inputSchema: toJsonSchema(inputs as z.ZodType),
      })
    } else if (p.kind === 'meta') {
      // Meta puts its LLM-facing tool at the top level (no primary wrapper);
      // emit the descriptor straight from `tool`. providerOptions lifting is
      // atomic-only (single model.call), so meta takes the BASE inputSchema.
      out.push({
        name: p.id,
        description: p.tool.description,
        inputSchema: toJsonSchema(p.tool.inputs),
      })
    } else if (p.kind === 'agent') {
      // An always-load agent (e.g. agent_orchestrator) is surfaced as a
      // first-class chat-turn tool so the main turn can delegate an open-ended
      // task in one hop. Its LLM-facing surface is `primary.tool` (same as
      // atomic); a host-only agent has no primary and is skipped.
      // providerOptions lifting is atomic-only, so the agent takes the BASE
      // inputSchema.
      if (p.primary) {
        out.push({
          name: p.id,
          description: p.primary.tool.description,
          inputSchema: toJsonSchema(p.primary.tool.inputs),
        })
      }
    }
  }
  return out
}
