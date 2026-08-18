// agent_orchestrator — a general open-ended media orchestration AgentPattern.
// The specialised sibling agent_long-form-video bakes a novel→video director
// workflow into its system prompt; this agent is the generalisation: no domain
// workflow, no embedded SKILL — the LLM plans a multi-step media task as it
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
import type { AgentPattern, AssetNeed } from '@orchestral/core'
import { agentInputSchema, extendInputsWithReferences } from '@orchestral/core'

import { IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID } from '../../atomic/image-to-image-via-caption'

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

// ── factory ──────────────────────────────────────────────────────────────

/**
 * Render the full system prompt for one dispatch: the cache-stable prefix
 * followed by a small "RUN PARAMETERS" tail carrying the typed `style` extra.
 * The variable bit lives in the suffix so the large prefix stays a stable
 * cache key across dispatches. The task brief itself rides in the framework
 * `prompt` seed (not the system prompt), keeping arbitrary prose out of the
 * cached prefix.
 */
function buildOrchestratorSystem(input: OrchestratorInput): string {
  const style =
    input.style && input.style.length > 0
      ? input.style
      : '(infer a consistent style from the task brief, if any)'
  return `${ORCHESTRATOR_SYSTEM_PROMPT}

---

## RUN PARAMETERS (this dispatch)

- Overall style: ${style}
- Your task brief is the first user message — parse the goals, constraints, and any provided asset handles from it.`
}

/** @alpha */
export function createOrchestratorAgent(): AgentPattern<OrchestratorInput> {
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
      system: (input: OrchestratorInput) => buildOrchestratorSystem(input),
      // Broad universe: every user-facing atomic + meta the orchestrator can
      // compose. Deliberately excludes ALL kind:'agent' patterns (including
      // itself) — dispatchAgent also auto-filters self, but no other agent is
      // listed either: orchestration composes atomics + metas, not agents.
      toolPatternIds: [
        // atomic generation / understanding capabilities
        'text-to-image',
        'image-to-image',
        'text-to-video',
        'image-to-video',
        'video-to-video',
        'text-to-speech',
        'text-to-audio',
        'automatic-speech-recognition',
        'image-to-text',
        'text-generation',
        // Canonical id is `meta_image-to-image-via-caption` (kind:'meta');
        // the bare name does not resolve in the registry. Import the exported
        // constant so this can't drift from the pattern's declared id again.
        IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
        // user-facing metas
        'meta_idea2video',
        'meta_script2video',
        'meta_image-best-of-n',
        'meta_reference-image-cascade',
        'meta_script-planning',
        'meta_storyboard',
        'meta_product-ad-short',
        'meta_product-photo-pack',
        'meta_ugc-testimonial',
        'meta_explainer-short',
        'meta_lyrics-to-mv',
        // agent-tool metas (middle-layer; visible to agent loops, this one
        // included — LLM-loop audience can compose them when it needs to)
        'meta_prose-chunking',
        'meta_novel-to-events',
        'meta_event-to-script',
      ],
      // Long-running sub-dispatches the agent loop can't block on
      // synchronously — routed through the async fan-out plumbing.
      asyncToolPatternIds: [
        'meta_idea2video',
        'meta_script2video',
        'meta_image-best-of-n',
        'meta_storyboard',
        'meta_product-ad-short',
        'meta_product-photo-pack',
        'meta_ugc-testimonial',
        'meta_explainer-short',
        'meta_lyrics-to-mv',
      ],
      // Fire-and-forget: this agent is meant to be started from a
      // conversational turn and outlive it, so a caller's abort must NOT
      // cascade in — only an explicit cancellation of this run ends it.
      // NB: defaultExecutionMode is left UNSET on purpose — setting 'async'
      // would trim this agent's own tool catalog to asyncToolPatternIds only.
      // No `stopWhen` here either: the step-count cap belongs to whoever runs
      // the agent, and the runtime's default applies unless overridden.
      abortMode: 'independent',
      modelTags: [],
    },
  }
}
