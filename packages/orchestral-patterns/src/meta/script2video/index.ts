// meta_script2video — MetaPattern.
//
// Turn a single-scene script into a video clip via an 8-stage DAG.
//   1. character-extraction        (text-generation)   — skip if provided
//   2. portrait-{front,side,back}  (3-view per visible character ∥:
//                                   front = text-to-image,
//                                   side = image-to-image (ref = front),
//                                   back = image-to-image (ref = front))
//   3. storyboard-design           (text-generation)
//   4. shot-visual-decomposition   (text-generation, ∥ per shot)
//   5. camera-tree-construction    (text-generation; consumed by Stage 6 to
//                                   route child shots through image-to-image
//                                   with their parent shot's first frame as
//                                   visual source)
//   6. cinematic-shot-framing      (per shot, sequential by parent→child:
//                                    root shot  = text-to-image (char portraits)
//                                    child shot = image-to-image (parent frame
//                                                 as source + missing_info hint))
//   7. i2v-shot-single             (image-to-video, ∥ per shot, startFrame=frame;
//                                   under transitionMode 'between-shots', N-1
//                                   extra clips render via i2v-shot-transition
//                                   and interleave into the concat order)
//   8. concatenate                 (host op — injected, no HF capability)
//
// FIDELITY NOTE: Stage 6 uses image-to-image primary for child shots (the
// primary path supported by modern multi-modal image-edit-capable models).
// Subject identity flows naturally: parent shot already encodes characters
// (themselves drawn via 3-view portrait references), so child shot inherits
// identity via parent's first frame without re-injecting portrait references.
//
// The 10 stage prompts are inlined as string constants in ./prompts. This meta
// is self-contained for its prompts: nothing is loaded at dispatch, no host
// binding for prompt loading. It still takes one real host-injected dep —
// `concatVideos` (Stage 8 has no HF capability). Each inlined prompt
// corresponds to exactly one atomic dispatch's system/prompt content:
// `portrait-front/side/back` and `i2v-shot-single/transition` are deliberate
// splits of what upstream described as single multi-call stages, so that one
// prompt never spans more than one atomic call.

import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import { createPatternFn, metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { textToImage } from '../../atomic/text-to-image'
import { imageToImage } from '../../atomic/image-to-image'
import { imageToVideo } from '../../atomic/image-to-video'
import {
  CHARACTER_EXTRACTION_PROMPT,
  PORTRAIT_FRONT_PROMPT,
  PORTRAIT_SIDE_PROMPT,
  PORTRAIT_BACK_PROMPT,
  STORYBOARD_DESIGN_PROMPT,
  SHOT_VISUAL_DECOMPOSITION_PROMPT,
  CAMERA_TREE_CONSTRUCTION_PROMPT,
  CINEMATIC_SHOT_FRAMING_PROMPT,
  I2V_SHOT_SINGLE_PROMPT,
  I2V_SHOT_TRANSITION_PROMPT,
} from './prompts'
import { firstAssetId, parseJsonWithSchema, resolvePrompts, sumCosts, toJsonSchemaCached, type MetaCommonDeps } from '../_shared/meta-utils'

// ── Per-step response models (mirror each stage prompt's [Output]) ─────────

/** @alpha */
export const CharacterInSceneSchema = z.object({
  idx: z.number().int(),
  identifierInScene: z.string(),
  staticFeatures: z.string(),
  dynamicFeatures: z.string(),
  isVisible: z.boolean(),
})
/** @alpha */
export type CharacterInScene = z.infer<typeof CharacterInSceneSchema>
const CharactersResponseSchema = z.object({
  characters: z.array(CharacterInSceneSchema),
})

const ShotBriefSchema = z.object({
  idx: z.number().int(),
  is_last: z.boolean(),
  cam_idx: z.number().int(),
  visual_desc: z.string(),
  audio_desc: z.string(),
})
const StoryboardResponseSchema = z.object({ storyboard: z.array(ShotBriefSchema) })

const ShotDecompositionSchema = z.object({
  ff_desc: z.string(),
  ff_vis_char_idxs: z.array(z.number().int()),
  lf_desc: z.string(),
  lf_vis_char_idxs: z.array(z.number().int()),
  motion_desc: z.string(),
  variation_type: z.enum(['large', 'medium', 'small']),
  variation_reason: z.string(),
})

// Camera-tree response schema — Stage 5 output, consumed by Stage 6 to
// route child shots through image-to-image with their parent's first frame.
// Mirrors CAMERA_TREE_CONSTRUCTION_PROMPT's [Output] shape:
//   { camera_parent_items: [
//       { parent_cam_idx | null, parent_shot_idx | null,
//         reason?, is_parent_fully_covers_child | null,
//         missing_info | null }
//     ] }
// One entry per camera (indexed by cam_idx); root entries have null parents.
const CameraParentItemSchema = z.object({
  parent_cam_idx: z.number().int().nullable(),
  parent_shot_idx: z.number().int().nullable(),
  reason: z.string().optional(),
  is_parent_fully_covers_child: z.boolean().nullable(),
  missing_info: z.string().nullable().optional(),
})
type CameraParentItem = z.infer<typeof CameraParentItemSchema>
// CAMERA_TREE_CONSTRUCTION_PROMPT explicitly allows "null entries ... for
// free-standing cameras" — camera positions with no parent and no children.
// They appear at the same array index as the corresponding `cam_idx`, just
// signalling "root / orphan, no parent shot to consult".
const CameraTreeResponseSchema = z.object({
  camera_parent_items: z.array(CameraParentItemSchema.nullable()),
})

// ── Pattern I/O ────────────────────────────────────────────────────────────

export const ScriptToVideoInputSchema = z.object({
  sceneScript: z
    .string()
    .min(1, 'sceneScript required')
    .describe('The scene script to turn into a video.'),
  style: z.string().optional().describe('Optional global visual style directive.'),
  userRequirement: z
    .string()
    .optional()
    .describe('Optional extra user requirements threaded into planning steps.'),
  characters: z
    .array(CharacterInSceneSchema)
    .optional()
    .describe('Pre-extracted characters; when present, stage 1 is skipped.'),
  transitionMode: z
    .enum(['none', 'between-shots'])
    .default('none')
    .optional()
    .describe(
      'Cross-shot transition rendering. "none" (default) keeps the legacy single-shot path. "between-shots" inserts an N-1 transition clip between each adjacent storyboard shot pair (consumes the i2v-shot-transition skill); raises i2v fan-out to 2N-1 clips before concat.',
    ),
})
export type ScriptToVideoInput = z.infer<typeof ScriptToVideoInputSchema>

export const ScriptToVideoOutputSchema = z.object({
  videoAssetId: z
    .string()
    .describe('Asset id of the final concatenated video.'),
  shotCount: z.number().int().min(0).describe('Number of shots rendered.'),
  ...metaEnvelopeShape,
})
export type ScriptToVideoOutput = z.infer<typeof ScriptToVideoOutputSchema>

export const SCRIPT2VIDEO_PATTERN_ID = 'meta_script2video'

/** Typed `ctx.step` sugar — dispatch this meta from another meta's compose(). */
export const script2videoMeta = createPatternFn<
  ScriptToVideoInput,
  ScriptToVideoOutput
>(SCRIPT2VIDEO_PATTERN_ID)

/**
 * @alpha
 * Default system prompts for meta_script2video's text/image/video sub-steps.
 * Consumers override any via `ScriptToVideoMetaDeps.prompts`; unset keys fall
 * back to these. `storyboardDesign` is this meta's own copy of the shared
 * storyboard-design prompt — overriding it here does not affect
 * meta_storyboard's independent `storyboardDesign` key.
 */
export const SCRIPT2VIDEO_DEFAULT_PROMPTS = Object.freeze({
  characterExtraction: CHARACTER_EXTRACTION_PROMPT,
  portraitFront: PORTRAIT_FRONT_PROMPT,
  portraitSide: PORTRAIT_SIDE_PROMPT,
  portraitBack: PORTRAIT_BACK_PROMPT,
  storyboardDesign: STORYBOARD_DESIGN_PROMPT,
  shotVisualDecomposition: SHOT_VISUAL_DECOMPOSITION_PROMPT,
  cameraTreeConstruction: CAMERA_TREE_CONSTRUCTION_PROMPT,
  cinematicShotFraming: CINEMATIC_SHOT_FRAMING_PROMPT,
  i2vShotSingle: I2V_SHOT_SINGLE_PROMPT,
  i2vShotTransition: I2V_SHOT_TRANSITION_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_script2video. */
export type ScriptToVideoPromptOverrides = Partial<
  Record<keyof typeof SCRIPT2VIDEO_DEFAULT_PROMPTS, string>
>

/**
 * @alpha
 * Host op: concatenate ordered video-clip assets into one final video asset.
 * No HF capability exists for this; the host supplies an ffmpeg-backed impl.
 * Injected to keep @orchestral/core provider-agnostic. `prompts` optionally
 * overrides any sub-step prompt; unset keys fall back to
 * {@link SCRIPT2VIDEO_DEFAULT_PROMPTS}.
 */
export type ScriptToVideoMetaDeps = Pick<MetaCommonDeps, 'concatVideos'> & {
  prompts?: ScriptToVideoPromptOverrides
}

/** @alpha */
export function createScript2VideoMeta(
  deps: ScriptToVideoMetaDeps,
): MetaPattern<ScriptToVideoInput, ScriptToVideoOutput> {
  const skills = loadSkills(deps.prompts)
  return {
    id: SCRIPT2VIDEO_PATTERN_ID,
    kind: 'meta',
    searchHint: 'turn a scene script into a storyboarded video clip',
    namespace: 'meta-pipelines',
    // Canonical meta surfaced as a first-class chat-turn tool so the main turn
    // can dispatch script→video in one hop (no find_pattern hop).
    exposureMode: 'always-load',
    description:
      'Turn a scene script into a video: extract characters, design a storyboard, decompose shots, build a camera tree, render first frames, animate each shot, and concatenate.',
    tool: {
      description:
        'Generate a video from a scene script. Plans characters, storyboard, and per-shot framing, renders a first frame per shot, animates each into a clip, and stitches the clips into one video.',
      inputs: ScriptToVideoInputSchema,
    },
    outputs: ScriptToVideoOutputSchema,
    async compose(params, ctx): Promise<ScriptToVideoOutput> {
      const { input } = params
      const startedAt = Date.now()
      const styleSuffix = input.style ? `\n\nStyle: ${input.style}` : ''

      // Running total of every paid sub-step's cost. The DAG is deep and
      // heterogeneous (text-gen + image + video across many stages), so we push
      // each call's cost as it completes rather than reconstruct it at the end.
      const costs: number[] = []
      const runText = makeTextRunner(ctx)

      // Stage 1 — characters (skip when caller pre-supplied them).
      let characters = input.characters
      if (characters === undefined) {
        const charRun = await runText(
          skills.character,
          `<SCRIPT>\n${input.sceneScript}\n</SCRIPT>`,
          CharactersResponseSchema,
          'characters',
        )
        costs.push(charRun.cost)
        characters = charRun.data.characters
      }

      // Stage 2 — 3-view portrait registry per visible character. Each
      // character runs in parallel; within a character, front (t2i) must
      // finish before side ∥ back (both i2i, source = front). Front is
      // the only step that consumes character features — side and back
      // inherit identity from the front portrait via image-to-image and
      // never re-state features (avoids identity double-anchoring).
      //
      // The registry holds real assetIds (not handles): side/back chain
      // front's assetId through the internal-asset channel (ref.assets), and
      // Stage 6 root frames reference the 3-view portraits by assetId too.
      // image-to-image's `source` slot (assetNeeds: source[]) receives front.
      //
      // Image-gen atomics (text-to-image / image-to-image) have no system
      // slot, so each per-view prompt is folded into the prompt prefix.
      const visible = characters.filter((c) => c.isVisible)
      const portraitByCharIdx = new Map<
        number,
        { front: string; side: string; back: string }
      >()
      await parallel(
        visible.map(async (c) => {
          // Stage 2a — front view (text-to-image, no reference).
          const front = await textToImage(ctx, {
            // No generation overrides — the slimmed atomic defers to the
            // resolved model's native defaults; this meta consumes only the
            // first produced still, and a still's dimensions don't drive the
            // clip output (the image-to-video step owns that).
            prompt: `${skills.portraitFront}\n\nIdentifier: ${c.identifierInScene}\nFeatures: ${c.staticFeatures} ${c.dynamicFeatures}${styleSuffix}`,
          })
          const frontId = firstAssetId(front, 'script2video: step')

          // Stage 2b/2c — side ∥ back (image-to-image, source = front).
          const [side, back] = await parallel([
            imageToImage(
              ctx,
              {
                prompt: `${skills.portraitSide}\n\nIdentifier: ${c.identifierInScene}`,
              },
              { assets: [{ slot: 'source', assetId: frontId, modality: 'image' }] },
            ),
            imageToImage(
              ctx,
              {
                prompt: `${skills.portraitBack}\n\nIdentifier: ${c.identifierInScene}`,
              },
              { assets: [{ slot: 'source', assetId: frontId, modality: 'image' }] },
            ),
          ])
          costs.push(front.cost, side.cost, back.cost)

          portraitByCharIdx.set(c.idx, {
            front: frontId,
            side: firstAssetId(side, 'script2video: step'),
            back: firstAssetId(back, 'script2video: step'),
          })
        }),
      )

      // Stage 3 — storyboard.
      const storyboardRun = await runText(
        skills.storyboard,
        buildStoryboardPrompt(input.sceneScript, characters, input.userRequirement),
        StoryboardResponseSchema,
        'storyboard',
      )
      costs.push(storyboardRun.cost)
      const { storyboard } = storyboardRun.data

      // Stage 4 ∥ Stage 5 — decompose + camera tree (both depend on
      // storyboard, independent of each other).
      const [decompositionRuns, cameraTreeRun] = await parallel([
        parallel(
          storyboard.map((shot) =>
            runText(
              skills.decompose,
              buildDecompositionPrompt(shot.visual_desc, visible),
              ShotDecompositionSchema,
              'shot decomposition',
            ),
          ),
        ),
        runText(
          skills.cameraTree,
          buildCameraTreePrompt(storyboard),
          CameraTreeResponseSchema,
          'camera tree',
        ),
      ])
      const decompositions = decompositionRuns.map((r) => r.data)
      costs.push(...decompositionRuns.map((r) => r.cost), cameraTreeRun.cost)
      const cameraTree = cameraTreeRun.data.camera_parent_items

      // Stage 6 — first frame per shot. Sequential by parent→child order so
      // a child shot's image-to-image dispatch can reference its parent's
      // already-rendered frame. Root shots (parent_cam_idx === null) go
      // through text-to-image with the character portrait registry; child
      // shots go through image-to-image primary with the parent's first
      // frame as the `source` asset + missing_info from the camera tree
      // appended to the prompt.
      //
      // Subject identity for child shots flows through the parent frame —
      // we deliberately drop the per-shot portrait reference there: the
      // characters are already drawn in the parent (which itself rendered
      // with portraits), and double-anchoring portraits + parent confuses
      // the image-edit provider.
      //
      // `frameIds[i]` and `frameIdByShotIdx[shot.idx]` are kept in lock-step,
      // both carrying real assetIds. The array carries the storyboard-order
      // sequence Stage 7 consumes; the map handles parent lookup by
      // model-reported global `parent_shot_idx`, which is not guaranteed to
      // equal the storyboard array position when the LLM emits non-contiguous
      // shot indices. Sub-step source/reference assets flow by assetId via the
      // internal-asset channel (ref.assets), not the LLM-facing handle layer.
      const frameIds: string[] = []
      const frameIdByShotIdx = new Map<number, string>()
      for (let i = 0; i < storyboard.length; i++) {
        const shot = storyboard[i]
        const d = decompositions[i]
        if (!shot || !d) continue
        const parentEntry = cameraTree[shot.cam_idx]
        const parentShotIdx = parentEntry?.parent_shot_idx ?? null
        const parentFrameId =
          parentShotIdx !== null
            ? frameIdByShotIdx.get(parentShotIdx)
            : undefined

        let frameId: string
        if (parentFrameId && parentEntry) {
          // Child shot — image-to-image, source = parent's first frame.
          const childFrame = await imageToImage(
            ctx,
            {
              prompt: composeChildFramePrompt(
                skills.frame,
                d,
                parentEntry,
                styleSuffix,
              ),
            },
            { assets: [{ slot: 'source', assetId: parentFrameId, modality: 'image' }] },
          )
          costs.push(childFrame.cost)
          frameId = firstAssetId(childFrame, 'script2video: step')
        } else {
          // Root shot (no parent, or parent frame not yet computed —
          // defensive: the camera-tree prompt says the first camera must be
          // the root, so index 0 is always root and processed first in this
          // loop). The 3-view portraits feed text-to-image's `reference` slot
          // by assetId.
          const rootFrame = await textToImage(
            ctx,
            {
              // No generation overrides — defers to the resolved model's
              // native defaults (see the Stage 2a note above).
              prompt: `${skills.frame}\n\n${d.ff_desc}${styleSuffix}`,
            },
            {
              assets: d.ff_vis_char_idxs.flatMap((idx) => {
                const p = portraitByCharIdx.get(idx)
                return p
                  ? ([
                      { slot: 'reference', assetId: p.front, modality: 'image' as const },
                      { slot: 'reference', assetId: p.side, modality: 'image' as const },
                      { slot: 'reference', assetId: p.back, modality: 'image' as const },
                    ])
                  : []
              }),
            },
          )
          costs.push(rootFrame.cost)
          frameId = firstAssetId(rootFrame, 'script2video: step')
        }
        frameIds.push(frameId)
        frameIdByShotIdx.set(shot.idx, frameId)
      }

      // Stage 7 — animate each shot from its first frame (∥). The single-shot
      // path renders one clip per storyboard shot; when transitionMode is
      // 'between-shots' we additionally render N-1 transition clips (each
      // anchored at the earlier shot's first frame, prompted with both shots'
      // visual descriptions via the i2v-shot-transition skill) and interleave
      // them into [shot0, trans0, shot1, trans1, ..., shotN-1] before concat.
      const transitionMode = input.transitionMode ?? 'none'

      const singleClips = await parallel(
        decompositions.map((d, i) =>
          imageToVideo(
            ctx,
            {
              prompt: `${skills.shotSingle}\n\n${d.motion_desc}`,
            },
            {
              assets: [
                { slot: 'startFrame', assetId: frameIds[i]!, modality: 'image' },
              ],
            },
          ),
        ),
      )
      costs.push(...singleClips.map((c) => c.cost))
      const singleClipIds = singleClips.map((r) =>
        firstAssetId(r, 'script2video: step'),
      )

      let orderedClipIds: readonly string[]
      if (transitionMode === 'between-shots' && storyboard.length >= 2) {
        const transitionClips = await parallel(
          storyboard.slice(0, -1).map((firstShot, i) =>
            imageToVideo(
              ctx,
              {
                prompt: buildTransitionPrompt(
                  skills.shotTransition,
                  firstShot.visual_desc,
                  storyboard[i + 1]!.visual_desc,
                  styleSuffix,
                ),
              },
              {
                assets: [
                  { slot: 'startFrame', assetId: frameIds[i]!, modality: 'image' },
                ],
              },
            ),
          ),
        )
        costs.push(...transitionClips.map((c) => c.cost))
        orderedClipIds = interleaveShotsAndTransitions(
          singleClipIds,
          transitionClips.map((r) => firstAssetId(r, 'script2video: step')),
        )
      } else {
        // 'none' OR transitionMode requested but fewer than 2 shots — no
        // adjacent pair exists, so behave like the single-shot path.
        orderedClipIds = singleClipIds
      }

      // Stage 8 — concatenate clips into the final video (host op, no model cost).
      const final = await ctx.compute('concat-final-video', () =>
        deps.concatVideos(orderedClipIds),
      )

      return {
        videoAssetId: final.assetId,
        shotCount: storyboard.length,
        // The DAG accumulates bare per-step costs (it's deep and heterogeneous —
        // pushing as calls complete is clearer than reconstructing at the end),
        // so wrap each for sumCosts to get the same NaN/Infinity-guarded total
        // every sibling meta uses. A plain reduce would let one bad adapter cost
        // poison the aggregate.
        cost: sumCosts(...costs.map((cost) => ({ cost }))),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface LoadedSkills {
  character: string
  portraitFront: string
  portraitSide: string
  portraitBack: string
  storyboard: string
  decompose: string
  cameraTree: string
  frame: string
  shotSingle: string
  shotTransition: string
}

// Stage prompts are compile-time constants, so "loading" them is a plain
// object literal — no ctx.compute, no async, nothing read at dispatch. Kept as
// a single helper so compose() reads one `skills.X` shape. The override merge
// runs through the shared resolvePrompts (defaults from the const), then this
// maps the public override keys onto the short compose-side names.
function loadSkills(overrides?: ScriptToVideoPromptOverrides): LoadedSkills {
  const p = resolvePrompts(SCRIPT2VIDEO_DEFAULT_PROMPTS, overrides)
  return {
    character: p.characterExtraction,
    portraitFront: p.portraitFront,
    portraitSide: p.portraitSide,
    portraitBack: p.portraitBack,
    storyboard: p.storyboardDesign,
    decompose: p.shotVisualDecomposition,
    cameraTree: p.cameraTreeConstruction,
    frame: p.cinematicShotFraming,
    shotSingle: p.i2vShotSingle,
    shotTransition: p.i2vShotTransition,
  }
}

/**
 * Compose the image-to-video transition prompt for a cut between two
 * adjacent storyboard shots. Mirrors I2V_SHOT_TRANSITION_PROMPT's [Output]
 * template — the prompt body is layered on as the system-level prefix, then
 * the two shots' visual descriptions are injected into the template structure
 * that body specifies.
 */
function buildTransitionPrompt(
  skillSystem: string,
  firstShotVisualDesc: string,
  secondShotVisualDesc: string,
  styleSuffix: string,
): string {
  return `${skillSystem}\n\nTwo shots. The transition between the shots is a cut to. The style of the two shots should be consistent.\nThe first shot description: ${firstShotVisualDesc}.\nThe second shot description: ${secondShotVisualDesc}.${styleSuffix}`
}

/**
 * Interleave single-shot clips with their adjacent transition clips into
 * concat order: [shot0, trans0, shot1, trans1, ..., shotN-2, transN-2, shotN-1].
 * `transitions.length` must equal `shots.length - 1`.
 */
function interleaveShotsAndTransitions(
  shots: readonly string[],
  transitions: readonly string[],
): readonly string[] {
  if (transitions.length !== shots.length - 1) {
    throw new Error(
      `script2video: transition interleave expected ${shots.length - 1} transitions, got ${transitions.length}`,
    )
  }
  const out: string[] = []
  for (let i = 0; i < shots.length; i++) {
    out.push(shots[i]!)
    if (i < transitions.length) out.push(transitions[i]!)
  }
  return out
}

function makeTextRunner(ctx: ExecutionContext) {
  return async function runText<T extends z.ZodType>(
    system: string,
    prompt: string,
    schema: T,
    step: string,
  ): Promise<{ data: z.infer<T>; cost: number }> {
    const out = await textGeneration(ctx, {
      system,
      prompt,
      responseFormat: 'json',
      jsonSchema: toJsonSchemaCached(schema),
    })
    // Cast: parseJsonWithSchema can't infer through the generic schema param.
    return {
      data: parseJsonWithSchema(out.text, schema, `script2video: ${step}`) as z.infer<T>,
      cost: out.cost,
    }
  }
}

/**
 * Render the `<CHARACTERS>` block body. `#idx` is the character's extraction
 * index — the same index the decomposition step reports back in
 * `ff_vis_char_idxs` / `lf_vis_char_idxs` and Stage 6 uses to look up
 * portraits, so it must be stated explicitly rather than implied by line
 * order.
 */
function characterLines(
  characters: ReadonlyArray<CharacterInScene>,
  withDynamic: boolean,
): string {
  return characters
    .map((c) => {
      const features = withDynamic
        ? `${c.staticFeatures} ${c.dynamicFeatures}`.trim()
        : c.staticFeatures
      return `#${c.idx} ${c.identifierInScene}: ${features}`
    })
    .join('\n')
}

/**
 * Build the `shot-visual-decomposition` user prompt.
 * SHOT_VISUAL_DECOMPOSITION_PROMPT declares two input blocks — the shot's
 * visual description in `<VISUAL_DESC>` and the candidate character list in
 * `<CHARACTERS>` — and its output indexes
 * characters by position in that list. Only visible characters are listed
 * (off-screen voices cannot appear in a frame), each labelled with its own
 * extraction index so `ff_vis_char_idxs` stays addressable by the portrait
 * registry in Stage 6.
 */
function buildDecompositionPrompt(
  visualDesc: string,
  characters: ReadonlyArray<CharacterInScene>,
): string {
  return `<VISUAL_DESC>\n${visualDesc}\n</VISUAL_DESC>\n\n<CHARACTERS>\n${characterLines(characters, true)}\n</CHARACTERS>`
}

function buildStoryboardPrompt(
  script: string,
  characters: ReadonlyArray<CharacterInScene>,
  userRequirement: string | undefined,
): string {
  const chars = characterLines(characters, false)
  // STORYBOARD_DESIGN_PROMPT reads the optional requirement from
  // <USER_REQUIREMENT> — emit that exact tag. Any other tag name is silently
  // ignored: the prompt never looks for it and the model never sees the
  // requirement, with no error anywhere.
  const req = userRequirement ? `\n\n<USER_REQUIREMENT>\n${userRequirement}\n</USER_REQUIREMENT>` : ''
  return `<SCRIPT>\n${script}\n</SCRIPT>\n\n<CHARACTERS>\n${chars}\n</CHARACTERS>${req}`
}

/**
 * Format storyboard into the `<CAMERA_SEQ><CAMERA_N>Shot N: ...</CAMERA_N></CAMERA_SEQ>`
 * shape that CAMERA_TREE_CONSTRUCTION_PROMPT expects as input.
 * Shots are grouped by `cam_idx` (the camera-position index) and listed in
 * storyboard order within each group.
 */
function buildCameraTreePrompt(
  storyboard: ReadonlyArray<{
    idx: number
    cam_idx: number
    visual_desc: string
  }>,
): string {
  const byCam = new Map<number, string[]>()
  for (const shot of storyboard) {
    const lines = byCam.get(shot.cam_idx) ?? []
    lines.push(`Shot ${shot.idx}: ${shot.visual_desc}`)
    byCam.set(shot.cam_idx, lines)
  }
  const camIdxsSorted = [...byCam.keys()].sort((a, b) => a - b)
  const cameraBlocks = camIdxsSorted
    .map((camIdx) => {
      const inner = (byCam.get(camIdx) ?? []).join('\n')
      return `<CAMERA_${camIdx}>\n${inner}\n</CAMERA_${camIdx}>`
    })
    .join('\n')
  return `<CAMERA_SEQ>\n${cameraBlocks}\n</CAMERA_SEQ>`
}

/**
 * Compose the image-to-image prompt for a child shot whose first frame
 * inherits from its parent's first frame. Layers CINEMATIC_SHOT_FRAMING_PROMPT
 * on top of the shot's own `ff_desc`, then appends a hint block
 * derived from the camera-tree entry — `missing_info` tells the model
 * what's specifically new in the child shot relative to the parent (e.g.
 * "frontal view of Alice"), and `is_parent_fully_covers_child=false`
 * indicates the child needs additional content beyond the parent's
 * field of view.
 */
function composeChildFramePrompt(
  skillSystem: string,
  d: { ff_desc: string },
  parentEntry: CameraParentItem,
  styleSuffix: string,
): string {
  let prompt = `${skillSystem}\n\n${d.ff_desc}${styleSuffix}`
  if (
    parentEntry.missing_info &&
    parentEntry.missing_info.trim().length > 0
  ) {
    prompt += `\n\n[Camera-tree hint] Add to the parent-shot reference: ${parentEntry.missing_info}`
  } else if (parentEntry.is_parent_fully_covers_child === false) {
    prompt += `\n\n[Camera-tree hint] The child shot needs framing beyond the parent reference — render the new composition while preserving subjects and lighting from the parent.`
  }
  return prompt
}
