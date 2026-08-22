// agent_long-form-video — the first production AgentPattern. It embeds two
// prompt bodies: the long-form-video "director" workflow, and the
// character-merge-event-to-novel merge instructions.
//
// kind: 'agent' — the LLM decides the per-iteration plan: which sub-meta to
// dispatch next, when to ask the user via a widget for quality / failure /
// style decisions, and when to stop. The host writes the tool catalog
// (toolPatternIds + host-injected agent tools); the LLM picks among them per
// turn.
//
// Plan rationale:
//   The graph this pipeline walks is fundamentally LLM-decided. Three
//   mid-flight interventions (quality / failure / style) need case-by-case
//   judgement against runtime cumulative state — a fixed meta would have to
//   bake the policy into host code, whereas an agent puts policy in the SKILL
//   where the LLM can read accumulated context and pick. Scheduling authority
//   is what distinguishes a meta from an agent.
//
// Resume: a crashed or cancelled run is NOT restarted for you. A run resumes
// only when the host re-dispatches it with `JobSpec.resumeFromRunId`, which
// replays the recorded transcript back into the loop; the director prompt's
// RESUME AWARENESS section then tells the LLM to read prior tool calls out of
// that transcript and skip already-completed events / scenes. That replay is
// the whole mechanism — no dispatch-level checkpoint infrastructure on top.
//
// Both prompt bodies (director + character-merge) are string constants in
// ./prompts, which is their authoritative source — there is no on-disk copy to
// stay in sync with and nothing is loaded at runtime. The factory bakes them
// into loop.system. No SkillLoader, no host binding for prompt loading.

import { z } from 'zod'
import {
  agentInputSchema,
  type AgentPattern,
} from '@orchestral/core'
import {
  LONG_FORM_VIDEO_DIRECTOR_PROMPT,
  CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT,
} from './prompts'

// ── input / output ──────────────────────────────────────────────────────

// AgentPattern inputs MUST go through agentInputSchema(): the framework
// injects `description` + `prompt` (the seed user message) + `references`,
// and dispatchAgent throws AGENT_SEED_PROMPT_MISSING without a non-empty
// `prompt`. The novel itself rides in `prompt` (the parent LLM's task
// brief) — NOT a separate field — so it never bloats the byte-stable
// loop.system prefix. `style` / `maxEvents` are small typed extras the
// loop.system function appends after the cached SKILL prefix.
export const AgentLongFormVideoInputSchema = agentInputSchema({
  style: z
    .string()
    .optional()
    .describe(
      'Optional visual style hint (e.g. "noir, high contrast"). When omitted the director infers a style from the task brief and applies it consistently.',
    ),
  maxEvents: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Optional safeguard cap the director forwards into meta_novel-to-events (per-event chain length). Defaults to 50 inside that meta when omitted.',
    ),
})
export type AgentLongFormVideoInput = z.infer<
  typeof AgentLongFormVideoInputSchema
>

export const AGENT_LONG_FORM_VIDEO_PATTERN_ID = 'agent_long-form-video'

// ── factory note ─────────────────────────────────────────────────────────
//
// The factory is no-arg: the prompts are inlined (./prompts) so there is no
// SkillLoader dep, and the Pattern declares no tools of its own. Its one host
// tool, `concat_videos`, is supplied by the host that runs the loop — it is
// named in the director prompt and in `loop`'s Stage 5 contract, but appears
// nowhere in this package, core, or runtime. `complete_task` is not a host
// tool at all: see the output-mechanism note below.
//
// Output mechanism: this pattern declares no `outputs` and no `finish`, so the
// registry backfills the default finish envelope — outputs
// `{ assets: [{ assetId, modality, label? }], summary, stepCount }` plus the
// default finish spec. At runtime the finish broker injects `complete_task`
// (wire name unchanged); the director hands back a `summary` and the `handles`
// of its final deliverable assets (here, the concatenated video), and the
// broker resolves those handles and composes the envelope. Step count is a run
// fact the runtime fills; scene/event counts and cost are dropped entirely
// (write-only telemetry with no accountant — not part of the envelope).

/**
 * Build the byte-stable system prefix: director SKILL + the fenced
 * character-merge SKILL (which the LLM copies verbatim into Stage 3.2's
 * text-generation `system`). This is the same for every dispatch, so it
 * forms the cacheable prompt prefix. Per-dispatch parameters are appended
 * *after* this prefix by `buildLongFormVideoSystem` so the prefix stays
 * cache-stable.
 */
function buildSystemPrefix(
  directorSkill: string,
  characterMergeSkill: string,
): string {
  return `${directorSkill}

---

## EMBEDDED SKILL — character-merge-event-to-novel

The director workflow above (Stage 3.2) instructs you to dispatch \`text-generation\` with the \`character-merge-event-to-novel\` SKILL as the \`system\` field. You do not have a SKILL loader at runtime — use the body below verbatim instead.

<EMBEDDED_SKILL_CHARACTER_MERGE_EVENT_TO_NOVEL>
${characterMergeSkill}
</EMBEDDED_SKILL_CHARACTER_MERGE_EVENT_TO_NOVEL>`
}

/**
 * Render the full system prompt for one dispatch: the cacheable prefix
 * followed by a small "RUN PARAMETERS" tail carrying the typed extras
 * (style / maxEvents). Variable bits live in the suffix so the large
 * prefix remains a stable cache key across dispatches.
 *
 * The novel itself is NOT here — it arrives as the framework `prompt`
 * seed (the parent LLM's task brief), keeping arbitrarily large prose out
 * of the system prompt entirely.
 */
function buildLongFormVideoSystem(
  prefix: string,
  input: AgentLongFormVideoInput,
): string {
  const style =
    input.style && input.style.length > 0
      ? input.style
      : '(infer a single consistent style from the task brief)'
  const maxEvents = input.maxEvents ?? 50
  return `${prefix}

---

## RUN PARAMETERS (this dispatch)

- Visual style: ${style}
- Max events (pass as meta_novel-to-events.maxEvents): ${maxEvents}
- The novel / prose to adapt is your task brief — the first user message.
  Parse the prose and any additional guidance from it.`
}

// ── factory ──────────────────────────────────────────────────────────────

/** @alpha */
export function createLongFormVideoAgent(): AgentPattern<AgentLongFormVideoInput> {
  // Cacheable system prefix — computed once at factory time from the
  // inlined SKILL bodies. loop.system closes over it and appends only
  // the per-dispatch run parameters.
  const prefix = buildSystemPrefix(
    LONG_FORM_VIDEO_DIRECTOR_PROMPT,
    CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT,
  )
  return {
    id: AGENT_LONG_FORM_VIDEO_PATTERN_ID,
    kind: 'agent',
    searchHint:
      'generate a long-form multi-event video from a novel with cross-chapter character continuity',
    namespace: 'meta-pipelines',
    description:
      'Direct a long-form video from a novel: extract events, plan scenes per event, render with cross-chapter character continuity, and concatenate. The LLM makes per-iteration decisions about which sub-pipeline to run next, quality re-render, and failure recovery — scheduling authority that a fixed meta DAG cannot express.',
    primary: {
      tool: {
        description:
          'Turn a novel into a long-form (multi-event, multi-scene) video. Walks novel → events → polished screenplays → rendered shots → final concat, deciding per-scene how to handle quality and failures as it goes.',
        inputs: AgentLongFormVideoInputSchema,
      },
    },
    loop: {
      // SKILL bodies baked in at factory time form the byte-stable cached
      // prefix; the per-dispatch `style` / `maxEvents` extras are appended as
      // a small suffix so the large prefix stays cacheable. The director SKILL
      // is the workflow guide; the character-merge SKILL is fenced for the LLM
      // to copy verbatim into Stage 3.2's text-generation `system`.
      system: (input: AgentLongFormVideoInput) =>
        buildLongFormVideoSystem(prefix, input),
      toolPatternIds: [
        // exposure: 'agent-tool' middle-layer metas (only this agent sees them):
        'meta_prose-chunking',
        'meta_novel-to-events',
        'meta_event-to-script',
        // exposure: 'tool' metas (publicly visible; this agent also uses them):
        'meta_script2video',
        'meta_image-best-of-n',
        // atomic — used directly for the character-merge-event-to-novel SKILL
        // call (host-mediated; SKILL body specified via the system field):
        'text-generation',
      ],
      // Long-running dispatches go through the async fan-out path so
      // cancellation and progress events stream through host plumbing
      // instead of blocking the agent loop.
      asyncToolPatternIds: ['meta_script2video', 'meta_image-best-of-n'],
      // No `stopWhen` here: the step-count cap belongs to whoever runs the
      // agent. Size it against this pattern's input bound, not against a
      // typical chat turn — a run costs roughly `maxEvents` × ~7 iterations
      // per event plus ~10 for framing, so at the schema's `maxEvents` cap of
      // 500 a complete run is ~3500 steps. A cap in the low hundreds does not
      // stop a runaway, it truncates legitimate long-novel runs mid-way.
      modelTags: [],
    },
  }
}
