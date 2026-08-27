// Catalog namespace partitioning.
//
// Every Pattern statically belongs to one NamespaceId. AgentPattern.loop.
// toolNamespaces picks which namespaces are exposed to the internal LLM, and
// catalog rendering groups by namespace. The catalog is byte-stable over an
// agent's lifetime (namespace structure + members don't change across
// dispatch); dynamic filtering (ancestor chain) goes through the blocklist
// below and never touches catalog descriptor bytes → the prompt prefix stays
// identical across turns, so provider-side prompt caching keeps hitting.
//
// Naming convention: slug-case, lowercase + hyphens.
//
// Host tools are not Patterns and never go through inferNamespace. A host that
// wants to group its own tools declares a namespace explicitly through the
// extension escape hatch (the `string & {}` fallback).

import type { PatternId } from './foundational'

/**
 * Stable grouping identifier for the Pattern catalog. Pattern authors declare
 * which namespace they belong to; AgentPattern.loop.toolNamespaces selects
 * namespaces to decide which tools a sub-agent sees.
 */
export type NamespaceId =
  | 'image-gen' // atomic capabilities whose output is an image
  | 'video-gen' // atomic capabilities whose output is a video
  | 'audio-gen' // atomic audio capabilities (speech / music / asr)
  | 'text-gen' // atomic capabilities whose output is text
  | 'meta-pipelines' // all meta_* Patterns
  | 'sub-agents' // all agent_* Patterns
  | 'uncategorized' // no modality group could be inferred (see inferNamespace)
  | (string & {}) // host extension escape hatch

/**
 * Default blocklist that prevents sub-agent recursion.
 *
 * Every `dispatchAgent` entry point adds these Pattern ids / prefixes to the
 * catalog blocklist when building a sub-agent's catalog. The LLM physically
 * cannot see `agent_*`-prefixed Patterns, so it can't emit a tool_use that
 * triggers recursion.
 *
 * **This is a normative contract, not a coincidence of naming.** The recursion
 * guard is implemented as an id-PREFIX match, so an AgentPattern whose id does
 * not start with `agent_` silently escapes it and can be dispatched from
 * inside another agent's loop. `AgentPatternId` in
 * [foundational.ts](./foundational.ts) is what makes the prefix mandatory —
 * the two must be changed together, and third-party agent authors MUST keep
 * the prefix.
 *
 * A Pattern author cannot opt back in. Listing an `agent_` id in
 * `loop.toolPatternIds` narrows that agent's allowlist; it does not override
 * this block, and `dispatchAgent` refuses such a call with SUBAGENT_BLOCKED
 * whether or not it was listed. Letting a sub-agent see a grand-agent means
 * judging against a different blocklist — this value is the only thing the
 * guards read.
 *
 * Same idea as denylisting the agent-dispatch tool itself to stop a sub-agent
 * from spawning further agents.
 */
/**
 * The shape of a sub-agent blocklist. Named so the guards that judge against
 * one can spell their parameter, and so a host widening the default has a type
 * to widen it into.
 */
export interface SubagentBlocklist {
  readonly idPrefixes: readonly string[]
  readonly patternIds: readonly PatternId[]
}

export const DEFAULT_SUBAGENT_BLOCKLIST: SubagentBlocklist = {
  idPrefixes: ['agent_'],
  patternIds: [],
}

/**
 * Judge one Pattern id against a sub-agent blocklist — the single executable
 * spelling of the prefix contract documented above.
 *
 * Three guards need this answer (the static catalog exclusion, the direct
 * dispatch guard, and the declared-inner-dispatch guard, all in
 * @orchestral/runtime's agent-dispatch), and each carried its own copy of the
 * same two-line expression. A prefix rule that is "a normative contract, not a
 * coincidence of naming" cannot live in three places, because a fourth path
 * added later has three things to imitate and one of them to miss.
 *
 * The return value is exactly the `matched` field `job:tool-rejected` already
 * reports, so a guard names the half that fired rather than recomputing it. A
 * prefix hit wins over an exact-id hit: an id can be both, and the prefix is
 * the broader statement about why it is refused.
 */
export function matchSubagentBlocklist(
  id: PatternId,
  blocklist: SubagentBlocklist = DEFAULT_SUBAGENT_BLOCKLIST,
): 'prefix' | 'id' | null {
  if (blocklist.idPrefixes.some((prefix) => id.startsWith(prefix))) return 'prefix'
  if (blocklist.patternIds.includes(id)) return 'id'
  return null
}

/**
 * Namespace for every capability literal an atomic Pattern id can be. Grouped
 * by media domain — the axis a catalog search filters on (see
 * `PatternSearchFilter.modality` in @orchestral/discovery) — so
 * `image-segmentation` groups with image, `summarization` / `translation`
 * with text, and speech recognition with audio (it is an audio capability
 * even though its output is text).
 *
 * Capabilities with no modality group (`embedding`) are deliberately absent:
 * they resolve to 'uncategorized' rather than being forced into a media
 * bucket they don't belong to.
 */
const CAPABILITY_NAMESPACE: Readonly<Record<string, NamespaceId>> = {
  'text-generation': 'text-gen',
  summarization: 'text-gen',
  translation: 'text-gen',
  'image-to-text': 'text-gen',
  'text-to-image': 'image-gen',
  'image-to-image': 'image-gen',
  'image-segmentation': 'image-gen',
  'text-to-video': 'video-gen',
  'image-to-video': 'video-gen',
  'video-to-video': 'video-gen',
  'text-to-speech': 'audio-gen',
  'text-to-audio': 'audio-gen',
  'audio-to-audio': 'audio-gen',
  'automatic-speech-recognition': 'audio-gen',
}

/**
 * Infer the default namespace for a PatternId — a fallback the registry calls
 * when a Pattern author hasn't explicitly tagged a namespace.
 *
 * All first-party Patterns should declare a namespace explicitly or carry a
 * kind prefix in their id; this function only covers Pattern authors who
 * didn't tag one.
 *
 * An id that is neither kind-prefixed nor a known capability literal resolves
 * to 'uncategorized'. It deliberately does NOT guess a media namespace: a
 * wrong guess makes the Pattern answer someone else's `modality` filter and
 * vanish from its own.
 *
 * Naming prefix: underscore rather than colon — the tool-name regex
 * `[a-zA-Z0-9_-]` most providers enforce does not accept colons.
 */
export function inferNamespace(id: PatternId): NamespaceId {
  if (id.startsWith('agent_')) return 'sub-agents'
  if (id.startsWith('meta_')) return 'meta-pipelines'
  return CAPABILITY_NAMESPACE[id] ?? 'uncategorized'
}

/**
 * The single normalization every namespace consumer must go through: an
 * explicit `Pattern.namespace` wins, otherwise the id is inferred.
 *
 * Both the registry's namespace index and the search index's modality filter
 * call this. Reading the bare `Pattern.namespace` field on one side while the
 * other side indexed the inferred value is the exact drift this closes — a
 * Pattern registered under an inferred namespace would then never match a
 * modality filter.
 */
export function resolveNamespace(
  id: PatternId,
  declared: NamespaceId | undefined,
): NamespaceId {
  return declared ?? inferNamespace(id)
}
