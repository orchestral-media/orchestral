// meta_script2video — MetaPattern.
//
// Turn a single-scene script into a video clip via an 8-stage DAG.
//   1. character-extraction        (text-generation)   — skip if provided
//   2. storyboard-design           (text-generation; refused past maxShots)
//   3. shot-visual-decomposition   (text-generation, ∥ per shot)
//      ∥ camera-tree-construction  (text-generation; keyed by cam_idx and
//                                   checked against the storyboard, consumed
//                                   by Stage 6 to route child shots through
//                                   image-to-image with their parent shot's
//                                   first frame as visual source)
//   4. render gate                 (ctx.askUser.confirm stating the exact
//                                   portrait / frame / clip counts; skipped
//                                   only on confirmBeforeRender: false)
//   5. portrait-{front,side,back}  (3-view per visible character ∥:
//                                   front = text-to-image,
//                                   side = image-to-image (ref = front),
//                                   back = image-to-image (ref = front))
//   6. cinematic-shot-framing      (per shot, sequential by parent→child:
//                                    root shot  = text-to-image (char portraits)
//                                    child shot = image-to-image (parent frame
//                                                 as source + missing_info hint);
//                                   a medium/large-variation shot renders its
//                                   last frame the same way, ∥ with the first)
//   7. i2v-shot-single             (image-to-video, ∥ per shot, startFrame=frame,
//                                   endFrame=last frame where one was rendered;
//                                   under transitionMode 'between-shots', N-1
//                                   extra clips render via i2v-shot-transition
//                                   and interleave into the concat order)
//   8. concatenate                 (host op — injected, no HF capability)
//
// Nothing paid beyond text-generation runs before Stage 4. The storyboard is
// planned, decomposed, and checked against maxShots and the camera tree
// first, so the gate can state the real counts and a refusal costs only the
// planning calls. Portraits therefore render after the gate, not before the
// storyboard as they once did.
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
import {
  firstAssetId,
  labelAsset,
  labelledAssetShape,
  parseJsonWithSchema,
  resolvePrompts,
  sumCosts,
  toJsonSchemaCached,
  type MetaCommonDeps,
} from '../_shared/meta-utils'

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
type ShotBrief = z.infer<typeof ShotBriefSchema>
// `.min(1)`: an empty storyboard would reach Stage 8 as a concat of nothing.
const StoryboardResponseSchema = z.object({ storyboard: z.array(ShotBriefSchema).min(1) })

/**
 * Stage 3 output per shot — mirrors SHOT_VISUAL_DECOMPOSITION_PROMPT's
 * [Output]. Every key here has a reader in compose(): the `ff_*` pair drives
 * the first frame, the `lf_*` pair the optional last frame, `motion_desc` is
 * the clip prompt, and `variation_type` decides whether the last frame is
 * rendered at all. The model is paid per output token, so a key nothing reads
 * is money spent on nothing — which is what `lf_desc`, `lf_vis_char_idxs`,
 * and `variation_type` were until the last frame was wired, and what
 * `variation_reason` (a justification written after the decision it
 * justified) was until it was dropped from the schema and the prompt. The
 * source-level test in meta-script2video.test.ts holds that line; this is
 * exported for it, not re-exported from the package.
 */
export const ShotDecompositionSchema = z.object({
  ff_desc: z.string(),
  ff_vis_char_idxs: z.array(z.number().int()),
  lf_desc: z.string(),
  lf_vis_char_idxs: z.array(z.number().int()),
  motion_desc: z.string(),
  variation_type: z.enum(['large', 'medium', 'small']),
})
type ShotDecomposition = z.infer<typeof ShotDecompositionSchema>

// Camera-tree response schema — Stage 3 output, consumed by Stage 6 to
// route child shots through image-to-image with their parent's first frame.
// Mirrors CAMERA_TREE_CONSTRUCTION_PROMPT's [Output] shape:
//   { camera_parent_items: [
//       { cam_idx, parent_cam_idx | null, parent_shot_idx | null,
//         reason?, is_parent_fully_covers_child | null,
//         missing_info | null }
//     ] }
// Exactly one entry per camera the storyboard uses, matched by the `cam_idx`
// the model echoes — never by array position (see indexCameraTree). A root
// or free-standing camera is an entry with null parent fields, not a null
// entry: a null carries no index to match on.
const CameraParentItemSchema = z.object({
  cam_idx: z.number().int(),
  parent_cam_idx: z.number().int().nullable(),
  parent_shot_idx: z.number().int().nullable(),
  reason: z.string().optional(),
  is_parent_fully_covers_child: z.boolean().nullable(),
  missing_info: z.string().nullable().optional(),
})
type CameraParentItem = z.infer<typeof CameraParentItemSchema>
const CameraTreeResponseSchema = z.object({
  camera_parent_items: z.array(CameraParentItemSchema),
})

// ── Pattern I/O ────────────────────────────────────────────────────────────

const DEFAULT_MAX_SHOTS = 12

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
  // The spend of this meta used to be whatever the storyboard model decided:
  // no input bounded the shot count, and every shot is at least one image and
  // one clip. The bound is told to the planning model and enforced after it
  // answers; the ceiling on the field itself is a sanity bound on an
  // LLM-filled number, not a product limit.
  maxShots: z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(DEFAULT_MAX_SHOTS)
    .describe(
      'Upper bound on storyboard shots. The storyboard step decides how many shots the scene needs and is told this bound; a storyboard that still exceeds it is refused (SCRIPT2VIDEO_SHOT_CAP_EXCEEDED) before any image or video is rendered. Each shot costs one first frame and one clip, plus a last frame when its motion is a medium/large change and, with transitionMode "between-shots", N-1 transition clips across the scene.',
    ),
  // `.default('none')` alone: the field is optional on the way in and always
  // set on the way out. The earlier `.default('none').optional()` declared
  // both that a missing value becomes 'none' and that the parsed value may be
  // undefined — the second undid the first in the inferred type.
  transitionMode: z
    .enum(['none', 'between-shots'])
    .default('none')
    .describe(
      'Cross-shot transition rendering. "none" (default) keeps the legacy single-shot path. "between-shots" inserts an N-1 transition clip between each adjacent storyboard shot pair (consumes the i2v-shot-transition skill); raises i2v fan-out to 2N-1 clips before concat.',
    ),
  confirmBeforeRender: z
    .boolean()
    .default(true)
    .describe(
      'Pause on a confirm that states the exact render counts (portraits, frames, clips) after planning and before the first paid image or video call. Set false only for a caller that has already bounded the spend through maxShots and has nobody to answer the prompt — on a runtime built without an askUser handler the gate fails with ASK_USER_NOT_SUPPORTED.',
    ),
})
export type ScriptToVideoInput = z.infer<typeof ScriptToVideoInputSchema>

// The dispatch-facing input uses the zod INPUT type (schema-`.default()`
// fields stay optional — the sub-step dispatch path applies no parse, so a
// parent meta fills only what it means to set and compose() resolves the
// rest). Same arrangement as the atomic PatternFns.
type ScriptToVideoDispatchInput = z.input<typeof ScriptToVideoInputSchema>

// Produced media rides in `assets[]` with a role `label` and nowhere else —
// see labelledAssetShape for why the projection needs it that way.
export const ScriptToVideoOutputSchema = z.object({
  assets: z
    .array(z.object(labelledAssetShape('video')))
    .describe(
      'The produced video: exactly one element, labelled `final-video` — every shot clip (and transition clip, when requested) concatenated in storyboard order. Empty when the user declined the render gate.',
    ),
  shotCount: z
    .number()
    .int()
    .min(0)
    .describe('Number of shots rendered; 0 when the user declined the render gate.'),
  ...metaEnvelopeShape,
})
export type ScriptToVideoOutput = z.infer<typeof ScriptToVideoOutputSchema>

export const SCRIPT2VIDEO_PATTERN_ID = 'meta_script2video'

/** Typed `ctx.step` sugar — dispatch this meta from another meta's compose(). */
export const script2videoMeta = createPatternFn<
  ScriptToVideoDispatchInput,
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
      'Turn a scene script into a video: extract characters, design a storyboard, decompose shots, build a camera tree, confirm the render counts, render first frames, animate each shot, and concatenate.',
    tool: {
      description:
        'Generate a video from a scene script. Plans characters, storyboard, and per-shot framing, confirms the render counts with the user, renders a first frame per shot, animates each into a clip, and stitches the clips into one video.',
      inputs: ScriptToVideoInputSchema,
    },
    outputs: ScriptToVideoOutputSchema,
    async compose(params, ctx): Promise<ScriptToVideoOutput> {
      const { input } = params
      const startedAt = Date.now()
      const styleSuffix = input.style ? `\n\nStyle: ${input.style}` : ''
      // A nested dispatch hands compose() the input as the parent wrote it,
      // so the schema defaults are applied here as well as declared above.
      const maxShots = input.maxShots ?? DEFAULT_MAX_SHOTS
      const transitionMode = input.transitionMode ?? 'none'
      const confirmBeforeRender = input.confirmBeforeRender ?? true

      // Running total of every paid sub-step's cost. The DAG is deep and
      // heterogeneous (text-gen + image + video across many stages), so we push
      // each call's cost as it completes rather than reconstruct it at the end.
      const costs: (number | null)[] = []
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
      const visible = characters.filter((c) => c.isVisible)

      // Stage 2 — storyboard. The shot bound goes to the model as a planning
      // constraint (the shared prompt reads it from <USER_REQUIREMENT>) and
      // is enforced on what comes back: a storyboard planned past it is
      // refused here, before decomposition and before anything is rendered.
      // Refused rather than sliced — a scene cut at shot N drops its ending,
      // and the caller asked for a bound, not an abridgement.
      const storyboardRun = await runText(
        skills.storyboard,
        buildStoryboardPrompt(input.sceneScript, characters, input.userRequirement, maxShots),
        StoryboardResponseSchema,
        'storyboard',
      )
      costs.push(storyboardRun.cost)
      const { storyboard } = storyboardRun.data
      if (storyboard.length > maxShots) {
        throw Object.assign(
          new Error(
            `SCRIPT2VIDEO_SHOT_CAP_EXCEEDED: the storyboard plans ${storyboard.length} shots and maxShots is ${maxShots}; nothing was rendered. Raise maxShots or give the scene fewer beats.`,
          ),
          { code: 'SCRIPT2VIDEO_SHOT_CAP_EXCEEDED' },
        )
      }

      // Stage 3 — decompose ∥ camera tree (both depend on the storyboard,
      // independent of each other).
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
      const cameraTree = indexCameraTree(cameraTreeRun.data.camera_parent_items, storyboard)

      // Stage 4 — render gate. Everything after this line is a paid image or
      // video call, and the counts are now exact: the storyboard fixes the
      // shots, the decompositions fix which shots get a last frame, and the
      // visible characters fix the portraits.
      const counts = renderCounts(visible, storyboard, decompositions, transitionMode)
      if (confirmBeforeRender) {
        const confirmed = await ctx.askUser.confirm({
          title: `Render ${counts.portraits} portraits, ${counts.frames} frames, and ${counts.clips} clips?`,
          body: renderGateBody(visible, storyboard, decompositions),
        })
        if (!confirmed) {
          return {
            assets: [],
            shotCount: 0,
            cost: sumCosts(costs),
            latencyMs: Date.now() - startedAt,
          }
        }
      }

      // Stage 5 — 3-view portrait registry per visible character. Each
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
      const portraitByCharIdx = new Map<number, PortraitSet>()
      await parallel(
        visible.map(async (c) => {
          // Stage 5a — front view (text-to-image, no reference).
          const front = await textToImage(ctx, {
            // No generation overrides — the slimmed atomic defers to the
            // resolved model's native defaults; this meta consumes only the
            // first produced still, and a still's dimensions don't drive the
            // clip output (the image-to-video step owns that).
            prompt: `${skills.portraitFront}\n\nCharacter: ${c.identifierInScene}\nFeatures: ${c.staticFeatures} ${c.dynamicFeatures}${styleSuffix}`,
          })
          const frontId = firstAssetId(front, 'script2video: step')

          // Stage 5b/5c — side ∥ back (image-to-image, source = front).
          const [side, back] = await parallel([
            imageToImage(
              ctx,
              {
                prompt: `${skills.portraitSide}\n\nCharacter: ${c.identifierInScene}`,
              },
              { assets: [{ slot: 'source', assetId: frontId, modality: 'image' }] },
            ),
            imageToImage(
              ctx,
              {
                prompt: `${skills.portraitBack}\n\nCharacter: ${c.identifierInScene}`,
              },
              { assets: [{ slot: 'source', assetId: frontId, modality: 'image' }] },
            ),
          ])
          costs.push(front.cost, side.cost, back.cost)

          portraitByCharIdx.set(c.idx, {
            identifier: c.identifierInScene,
            front: frontId,
            side: firstAssetId(side, 'script2video: step'),
            back: firstAssetId(back, 'script2video: step'),
          })
        }),
      )

      // Stage 6 — frames. Sequential by parent→child order so a child
      // shot's image-to-image dispatch can reference its parent's
      // already-rendered first frame. Root shots (parent_cam_idx === null)
      // go through text-to-image with the character portrait registry; child
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
      // A shot's last frame, when its variation is medium or large, takes
      // the same path as its first frame — same parent source or the same
      // portrait anchors (now for the characters visible at the end, which
      // can differ: a 'medium' variation is typically someone entering) —
      // and the two render in parallel. The decomposition prompt has always
      // asked for `lf_desc`; until this was wired it was paid for and thrown
      // away, and the video model never saw the end composition the prompt
      // promised it.
      //
      // `frames[i]` (storyboard order, consumed by Stage 7) and
      // `frameIdByShotIdx` (parent lookup by the model-reported global
      // `parent_shot_idx`, which is not guaranteed to equal the storyboard
      // array position) are kept in lock-step. Sub-step source/reference
      // assets flow by assetId via the internal-asset channel (ref.assets),
      // not the LLM-facing handle layer.
      const renderFrame = async (
        desc: string,
        visCharIdxs: readonly number[],
        entry: CameraParentItem,
        parentFrameId: string | undefined,
      ): Promise<string> => {
        if (parentFrameId !== undefined) {
          // Child shot — image-to-image, source = parent's first frame.
          const childFrame = await imageToImage(
            ctx,
            { prompt: composeChildFramePrompt(skills.frame, desc, entry, styleSuffix) },
            { assets: [{ slot: 'source', assetId: parentFrameId, modality: 'image' }] },
          )
          costs.push(childFrame.cost)
          return firstAssetId(childFrame, 'script2video: step')
        }
        // Root shot (no parent, or parent frame not yet computed —
        // defensive: the camera-tree prompt says the first camera must be
        // the root, so index 0 is always root and processed first in this
        // loop). The 3-view portraits feed text-to-image's `reference` slot
        // by assetId, in the order the prompt's legend names them.
        const portraits = visCharIdxs.flatMap((idx) => {
          const p = portraitByCharIdx.get(idx)
          return p ? [p] : []
        })
        const rootFrame = await textToImage(
          ctx,
          {
            // No generation overrides — defers to the resolved model's
            // native defaults (see the Stage 5a note above).
            prompt: composeRootFramePrompt(skills.frame, desc, portraits, styleSuffix),
          },
          {
            assets: portraits.flatMap((p) => [
              { slot: 'reference', assetId: p.front, modality: 'image' as const },
              { slot: 'reference', assetId: p.side, modality: 'image' as const },
              { slot: 'reference', assetId: p.back, modality: 'image' as const },
            ]),
          },
        )
        costs.push(rootFrame.cost)
        return firstAssetId(rootFrame, 'script2video: step')
      }

      const frames: Array<{ first: string; last?: string }> = []
      const frameIdByShotIdx = new Map<number, string>()
      for (let i = 0; i < storyboard.length; i++) {
        const shot = storyboard[i]!
        const d = decompositions[i]!
        // indexCameraTree already failed the run if any storyboard camera
        // had no entry, so the lookup cannot miss here.
        const entry = cameraTree.get(shot.cam_idx)!
        const parentFrameId =
          entry.parent_shot_idx !== null
            ? frameIdByShotIdx.get(entry.parent_shot_idx)
            : undefined
        const [first, last] = await parallel([
          renderFrame(d.ff_desc, d.ff_vis_char_idxs, entry, parentFrameId),
          needsLastFrame(d)
            ? renderFrame(d.lf_desc, d.lf_vis_char_idxs, entry, parentFrameId)
            : Promise.resolve(undefined),
        ])
        frames.push(last !== undefined ? { first, last } : { first })
        frameIdByShotIdx.set(shot.idx, first)
      }

      // Stage 7 — animate each shot from its first frame (∥), towards its
      // last frame where one was rendered. The single-shot path renders one
      // clip per storyboard shot; when transitionMode is 'between-shots' we
      // additionally render N-1 transition clips (each anchored at the
      // earlier shot's first frame, prompted with both shots' visual
      // descriptions via the i2v-shot-transition skill) and interleave them
      // into [shot0, trans0, shot1, trans1, ..., shotN-1] before concat.
      const singleClips = await parallel(
        frames.map((f, i) =>
          imageToVideo(
            ctx,
            {
              prompt: buildShotClipPrompt(
                skills.shotSingle,
                decompositions[i]!.motion_desc,
                storyboard[i]!.audio_desc,
              ),
            },
            {
              assets: [
                { slot: 'startFrame', assetId: f.first, modality: 'image' as const },
                ...(f.last !== undefined
                  ? [{ slot: 'endFrame', assetId: f.last, modality: 'image' as const }]
                  : []),
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
                  { slot: 'startFrame', assetId: frames[i]!.first, modality: 'image' },
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
        assets: [labelAsset(final, 'video', 'final-video')],
        shotCount: storyboard.length,
        // The DAG accumulates bare per-step costs (it's deep and heterogeneous —
        // pushing as calls complete is clearer than reconstructing at the end);
        // sumCosts gives the same NaN/Infinity-guarded, null-propagating total
        // every sibling meta uses. A plain reduce would let one bad adapter cost
        // poison the aggregate, or quietly sum past an unreported one.
        cost: sumCosts(costs),
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

/** One visible character's 3-view portrait registry entry (real assetIds). */
interface PortraitSet {
  identifier: string
  front: string
  side: string
  back: string
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

/** A medium or large variation ends on a composition the first frame does not show. */
function needsLastFrame(d: ShotDecomposition): boolean {
  return d.variation_type !== 'small'
}

/**
 * Key the camera-tree answer by the `cam_idx` each entry echoes, and check it
 * covers every camera the storyboard uses. Storyboard camera indices are not
 * guaranteed contiguous — the storyboard prompt has the model reuse camera
 * positions, and a scene can end up on cameras 0 and 2 with no 1. The tree
 * used to be read positionally (`items[shot.cam_idx]`), which for that scene
 * made camera 2 index past a two-entry answer and quietly rendered the shot
 * as a root — the wrong frame, with no error anywhere. A camera the model did
 * not answer for, or answered twice, is now a coded failure before any render.
 */
function indexCameraTree(
  items: ReadonlyArray<CameraParentItem>,
  storyboard: ReadonlyArray<ShotBrief>,
): Map<number, CameraParentItem> {
  const byCam = new Map<number, CameraParentItem>()
  for (const item of items) {
    if (byCam.has(item.cam_idx)) {
      throw Object.assign(
        new Error(
          `SCRIPT2VIDEO_CAMERA_TREE_DUPLICATE: the camera tree answers for cam_idx ${item.cam_idx} more than once`,
        ),
        { code: 'SCRIPT2VIDEO_CAMERA_TREE_DUPLICATE' },
      )
    }
    byCam.set(item.cam_idx, item)
  }
  const used = [...new Set(storyboard.map((s) => s.cam_idx))].sort((a, b) => a - b)
  const missing = used.filter((cam) => !byCam.has(cam))
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `SCRIPT2VIDEO_CAMERA_TREE_INCOMPLETE: the camera tree has no entry for cam_idx ${missing.join(', ')} (the storyboard uses ${used.join(', ')})`,
      ),
      { code: 'SCRIPT2VIDEO_CAMERA_TREE_INCOMPLETE' },
    )
  }
  return byCam
}

/**
 * The exact paid-render counts the gate states. Portraits are three per
 * visible character; frames are one per shot plus one per shot whose
 * variation earns a last frame; clips are one per shot plus, under
 * 'between-shots', one per adjacent pair.
 */
function renderCounts(
  visible: ReadonlyArray<CharacterInScene>,
  storyboard: ReadonlyArray<ShotBrief>,
  decompositions: ReadonlyArray<ShotDecomposition>,
  transitionMode: 'none' | 'between-shots',
): { portraits: number; frames: number; clips: number } {
  const shots = storyboard.length
  const transitions = transitionMode === 'between-shots' && shots >= 2 ? shots - 1 : 0
  return {
    portraits: visible.length * 3,
    frames: shots + decompositions.filter(needsLastFrame).length,
    clips: shots + transitions,
  }
}

/** The gate body: who gets portraits, then the shot list as planned. */
function renderGateBody(
  visible: ReadonlyArray<CharacterInScene>,
  storyboard: ReadonlyArray<ShotBrief>,
  decompositions: ReadonlyArray<ShotDecomposition>,
): string {
  const who =
    visible.length > 0
      ? `Portraits (front, side, back) for: ${visible.map((c) => c.identifierInScene).join(', ')}`
      : 'No visible characters — no portraits'
  const shots = storyboard.map((s, i) => {
    const d = decompositions[i]!
    const tail = needsLastFrame(d) ? ' (+ last frame)' : ''
    return `${i + 1}. [cam ${s.cam_idx}] ${s.visual_desc.slice(0, 80)}${tail}`
  })
  return [who, ...shots].join('\n')
}

/**
 * The clip prompt for one shot: the i2v-shot-single prefix, then the shot's
 * motion line and — when the storyboard scripted one — its audio line, joined
 * by a single newline. The audio line is the storyboard's `audio_desc`
 * verbatim: its `[Speaker]` / `[Sound Effect]` tags are what the video
 * model's audio head reads. This meta used to send the motion line alone,
 * so every shot rendered silent no matter what dialogue the storyboard wrote.
 */
function buildShotClipPrompt(prefix: string, motionDesc: string, audioDesc: string): string {
  const audio = audioDesc.trim()
  return `${prefix}\n\n${motionDesc}${audio.length > 0 ? `\n${audio}` : ''}`
}

/**
 * Compose the image-to-video transition prompt for a cut between two
 * adjacent storyboard shots: the i2v-shot-transition prefix, then the two
 * shots' visual descriptions the prefix refers to.
 */
function buildTransitionPrompt(
  prefix: string,
  firstShotVisualDesc: string,
  secondShotVisualDesc: string,
  styleSuffix: string,
): string {
  return `${prefix}\n\nFirst shot: ${firstShotVisualDesc}\nSecond shot: ${secondShotVisualDesc}${styleSuffix}`
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
  ): Promise<{ data: z.infer<T>; cost: number | null }> {
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
  maxShots: number,
): string {
  const chars = characterLines(characters, false)
  // STORYBOARD_DESIGN_PROMPT reads the optional requirement from
  // <USER_REQUIREMENT> — emit that exact tag. Any other tag name is silently
  // ignored: the prompt never looks for it and the model never sees the
  // requirement, with no error anywhere. The shot bound rides in the same
  // block — "desired number of shots" is one of the things the prompt says
  // that block may carry — so the cap reaches the model as a planning
  // constraint, not only as the tripwire compose() applies to its answer.
  const req = [userRequirement?.trim(), `Use at most ${maxShots} shots.`]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join('\n')
  return `<SCRIPT>\n${script}\n</SCRIPT>\n\n<CHARACTERS>\n${chars}\n</CHARACTERS>\n\n<USER_REQUIREMENT>\n${req}\n</USER_REQUIREMENT>`
}

/**
 * Format storyboard into the `<CAMERA_SEQ><CAMERA_N>Shot N: ...</CAMERA_N></CAMERA_SEQ>`
 * shape that CAMERA_TREE_CONSTRUCTION_PROMPT expects as input.
 * Shots are grouped by `cam_idx` (the camera-position index) and listed in
 * storyboard order within each group. N is the storyboard's own camera
 * index, gaps included — the answer is matched back on it.
 */
function buildCameraTreePrompt(storyboard: ReadonlyArray<ShotBrief>): string {
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
 * Root-shot frame prompt: the framing prefix, a legend naming which of the
 * attached reference images belong to which character (three views per
 * character, in attachment order), then the frame description and style.
 * The legend is what makes the prefix's "identity anchors" sentence
 * actionable — the image model sees N reference images and otherwise has no
 * way to know that images 0-2 are one person and 3-5 another.
 */
function composeRootFramePrompt(
  prefix: string,
  desc: string,
  portraits: ReadonlyArray<PortraitSet>,
  styleSuffix: string,
): string {
  const legend =
    portraits.length > 0
      ? `\n\nReference images: ${portraits
          .map((p, i) => `images ${i * 3}-${i * 3 + 2} are ${p.identifier} (front, side, back)`)
          .join('; ')}.`
      : ''
  return `${prefix}${legend}\n\n${desc}${styleSuffix}`
}

/**
 * Compose the image-to-image prompt for a child shot whose frame inherits
 * from its parent's first frame. Layers CINEMATIC_SHOT_FRAMING_PROMPT on top
 * of the frame's own description, then appends a hint block derived from the
 * camera-tree entry — `missing_info` tells the model what's specifically new
 * in the child shot relative to the parent (e.g. "frontal view of Alice"),
 * and `is_parent_fully_covers_child=false` indicates the child needs
 * additional content beyond the parent's field of view.
 */
function composeChildFramePrompt(
  prefix: string,
  desc: string,
  parentEntry: CameraParentItem,
  styleSuffix: string,
): string {
  let prompt = `${prefix}\n\n${desc}${styleSuffix}`
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
