// agent_orchestrator — a general open-ended media orchestration AgentPattern.
// No domain workflow and no embedded SKILL (the novel→video director that
// bakes one into its system prompt lives in examples/long-form-video, as a
// reference host rather than API): the LLM plans a multi-step media task as it
// goes, composing whatever atomic + meta patterns fit, deciding each step from
// the previous result.
//
// kind: 'agent' — scheduling authority lives in the loop: the LLM picks which
// pattern to dispatch next, when to iterate for quality, and how to recover
// from failures. The host writes the tool catalog (toolPatternIds + universal
// host tools); the LLM picks per turn.
//
// Output mechanism: this pattern declares no `outputs` and no `finish`, so the
// registry backfills the default finish envelope — outputs
// `{ assets: [{ assetId, modality, label? }], summary, stepCount }` plus the
// default finish spec. At runtime the finish broker injects the `complete_task`
// tool (wire name unchanged); the model hands back a `summary` and the
// `handles` of its final deliverable assets, the broker resolves those handles
// to asset ids and composes the envelope at finish. The model never reports raw
// asset ids; step count is a run fact the runtime fills, and cost is dropped
// entirely (no accounting mechanism exists — it is not part of the envelope).
//
// Exposure: per-surface object form, visible to both chat-turn and the agent
// loop, with `exposureMode:'always-load'` so the main chat-turn sees it as a
// first-class tool it can delegate to in one hop.

import { z } from 'zod'
import type { AgentPattern, AssetNeed, PatternId } from '@orchestral/core'
import { agentInputSchema, extendInputsWithReferences } from '@orchestral/core'

import {
  FIRST_PARTY_PATTERN_IDS,
  PLAN_PATTERN_ID,
  resolvePrompts,
} from '@orchestral/patterns'

import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts'

// ── input / output ──────────────────────────────────────────────────────

// The orchestrator previously declared a hand-written LLM-facing `references`
// ARRAY — colliding with the framework's reserved slot-record field. Any
// dispatch carrying it failed closed with UNKNOWN_SLOT (declaredSlots=[]), and
// with no assetNeeds + no inheritParentAssets the child asset context seeded
// EMPTY: the subagent could list_assets the vault but never resolve a handle.
// It now goes through agentInputSchema() like every other AgentPattern:
// `references` is the framework slot record, resolved at the parent dispatch
// boundary into the child's seed inventory (passedIn → AgentAssetBridge →
// <available-assets>). Deliberately NOT inheritParentAssets — explicit
// per-dispatch grants keep the "subagent gets only what the parent hands it"
// containment property.

const ORCHESTRATOR_ASSET_NEEDS = [
  {
    slot: 'images',
    modality: 'image',
    cardinality: 'array',
    required: false,
    description:
      'Image assets the task works from (sources to edit, visual references, style guides). Describe each one\'s role by content/order in the brief — handle names are re-minted in the subagent\'s context.',
  },
  {
    slot: 'videos',
    modality: 'video',
    cardinality: 'array',
    required: false,
    description:
      'Video assets the task works from (footage to edit or reference). Describe each one\'s role by content/order in the brief — handle names are re-minted in the subagent\'s context.',
  },
  {
    slot: 'audios',
    modality: 'audio',
    cardinality: 'array',
    required: false,
    description:
      'Audio assets the task works from (music beds, voice references). Describe each one\'s role by content/order in the brief — handle names are re-minted in the subagent\'s context.',
  },
] as const satisfies readonly AssetNeed[]

export const OrchestratorInputSchema = agentInputSchema({
  style: z
    .string()
    .optional()
    .describe(
      'Optional overall style / aesthetic hint applied consistently across produced assets.',
    ),
})
export type OrchestratorInput = z.infer<typeof OrchestratorInputSchema>

export const AGENT_ORCHESTRATOR_PATTERN_ID = 'agent_orchestrator'

// ── tool universe ────────────────────────────────────────────────────────

// The whole shipped first-party catalog, read from @orchestral/patterns
// instead of re-typed here. The list this replaces was a hand-copy of that
// package's manifest and had already drifted once (a bare
// `image-to-image-via-caption` that resolves to nothing in the registry);
// a copy nobody diffs against its source is a second truth, not a narrower
// agent.
//
// One exclusion, and it is a decision rather than an omission:
//
//   • meta_plan — the orchestrator plans as it goes, so committing a static
//     DAG overlaps with its own scheduling authority. An agent that can both
//     schedule per step and submit a fixed graph has two planners.
//
// Every kind:'agent' Pattern stays out structurally: agents live in THIS
// package, not in @orchestral/patterns, so the catalog carries none —
// orchestration composes atomics + metas. (dispatchAgent also auto-filters
// the self id.)
const ORCHESTRATOR_TOOL_PATTERN_IDS: readonly PatternId[] = [
  ...FIRST_PARTY_PATTERN_IDS.atomic,
  ...FIRST_PARTY_PATTERN_IDS.meta,
].filter((id) => id !== PLAN_PATTERN_ID)

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompt for agent_orchestrator, keyed the way every shipped
 * meta keys its `*_DEFAULT_PROMPTS`. Consumers override via
 * `OrchestratorAgentInit.prompts`; an unset key falls back to this. Same
 * reason as the metas': tone / house style / localization is the consumer's
 * call, and the alternative here was forking a package whose entire content
 * is this one declaration.
 */
export const ORCHESTRATOR_DEFAULT_PROMPTS = Object.freeze({
  orchestratorSystem: ORCHESTRATOR_SYSTEM_PROMPT,
})

/** @alpha Prompt overrides for agent_orchestrator. */
export type OrchestratorPromptOverrides = Partial<
  Record<keyof typeof ORCHESTRATOR_DEFAULT_PROMPTS, string>
>

/**
 * @alpha
 * Optional init for agent_orchestrator. Every field is a default this package
 * picked on the host's behalf, not a fact about the pattern: the prompt body,
 * which Patterns this deployment will pay for, and whether a caller's abort
 * cascades in. What is NOT here stays absent on purpose — `stopWhen` belongs
 * to whoever runs the agent, `outputs` / `finish` to the registry backfill,
 * `modelTags` to the Router.
 */
export type OrchestratorAgentInit = {
  prompts?: OrchestratorPromptOverrides
  /**
   * The tool universe. Defaults to the shipped first-party catalog minus
   * meta_plan (see ORCHESTRATOR_TOOL_PATTERN_IDS) — a host that registers a
   * subset of @orchestral/patterns must narrow this to match, since an id the
   * registry lacks now fails the dispatch loudly.
   */
  toolPatternIds?: readonly PatternId[]
  /** Defaults to `'independent'` — see the loop comment for why. */
  abortMode?: 'inherit' | 'independent'
}

/**
 * Render the full system prompt for one dispatch: the cache-stable prefix
 * followed by a small "RUN PARAMETERS" tail carrying the typed `style` extra.
 * The variable bit lives in the suffix so the large prefix stays a stable
 * cache key across dispatches. The task brief itself rides in the framework
 * `prompt` seed (not the system prompt), keeping arbitrary prose out of the
 * cached prefix.
 */
function buildOrchestratorSystem(
  input: OrchestratorInput,
  systemPrompt: string,
): string {
  const style =
    input.style && input.style.length > 0
      ? input.style
      : '(infer a consistent style from the task brief, if any)'
  return `${systemPrompt}

---

## RUN PARAMETERS (this dispatch)

- Overall style: ${style}
- Your task brief is the first user message — parse the goals, constraints, and any provided asset handles from it.`
}

/** @alpha */
export function createOrchestratorAgent(
  init: OrchestratorAgentInit = {},
): AgentPattern<OrchestratorInput> {
  const resolved = resolvePrompts(ORCHESTRATOR_DEFAULT_PROMPTS, init.prompts)
  return {
    id: AGENT_ORCHESTRATOR_PATTERN_ID,
    kind: 'agent',
    searchHint:
      'orchestrate an open-ended multi-step media task by composing generation patterns',
    namespace: 'meta-pipelines',
    description:
      'General media-production orchestrator: accomplish an open-ended, multi-step media task by composing the available atomic + meta generation patterns, deciding each step from the result of the previous one. The LLM owns scheduling — which pattern to dispatch next, when to iterate for quality, and how to recover from failures — authority a fixed meta DAG cannot express.',
    // Per-surface visibility: both the main chat-turn and any parent agent
    // loop may delegate to the orchestrator.
    exposure: { chatTurn: true, agentLoop: true },
    // Surface as a first-class chat-turn tool so the main turn can delegate an
    // open-ended task in one hop (no find_pattern → dispatch_pattern
    // round-trip).
    exposureMode: 'always-load',
    assetNeeds: ORCHESTRATOR_ASSET_NEEDS,
    primary: {
      tool: {
        description:
          'Use for open-ended, multi-step media tasks needing planning and adaptive decisions across several generation steps — composing multiple patterns, iterating on quality, recovering from failures — where no single existing pattern covers the whole job end-to-end. For a single generation (one image/video/audio), or a task one existing pattern already does end-to-end, dispatch that pattern directly instead. This runs ASYNCHRONOUSLY: you get an immediate launch acknowledgement with a jobId, not the result — do not wait or poll; the finished result arrives as a new message later. Attach the assets the task works from via references.images/videos/audios — the subagent cannot see your session\'s assets otherwise.',
        inputs: extendInputsWithReferences(
          AGENT_ORCHESTRATOR_PATTERN_ID,
          OrchestratorInputSchema,
          ORCHESTRATOR_ASSET_NEEDS,
        ),
      },
    },
    loop: {
      // System is the byte-stable prefix + a small per-dispatch suffix
      // carrying `style`. No embedded SKILL — the orchestrator does not load
      // skills; aesthetic guidance arrives via the brief / references.
      system: (input: OrchestratorInput) =>
        buildOrchestratorSystem(input, resolved.orchestratorSystem),
      // The tool universe is the shipped catalog minus meta_plan — see
      // ORCHESTRATOR_TOOL_PATTERN_IDS above for both halves of the reasoning.
      toolPatternIds: init.toolPatternIds ?? ORCHESTRATOR_TOOL_PATTERN_IDS,
      // No async catalog: this agent has one tool universe, on purpose.
      // `asyncToolPatternIds` prunes the catalog to
      // `toolPatternIds ∩ asyncToolPatternIds`, and only when
      // defaultExecutionMode is 'async' — which this pattern leaves unset,
      // because the async catalog would drop the atomics it composes between
      // metas. Declaring the list anyway would be a second thing to keep in
      // sync that buys no behaviour.
      //
      // Fire-and-forget by default: this agent is meant to be started from a
      // conversational turn and outlive it, so a caller's abort must NOT
      // cascade in — only an explicit cancellation of this run ends it. A host
      // that dispatches it synchronously overrides via init.abortMode.
      // No `stopWhen` here either: the step-count cap belongs to whoever runs
      // the agent, and the runtime's default applies unless overridden.
      abortMode: init.abortMode ?? 'independent',
      modelTags: [],
    },
  }
}
