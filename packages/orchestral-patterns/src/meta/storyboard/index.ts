// meta_storyboard — MetaPattern (deterministic one-shot storyboarding).
//
// Real-world pain point: the user has character reference sheets (three-view
// turnarounds) and wants a coherent storyboard. Left to free orchestration,
// an LLM either defaults to text-to-image and loses identity consistency, or
// switches to i2i but feeds only one reference per panel — dropping one
// character's identity when two share a frame. This meta hardens the "right
// way" into a deterministic flow:
//   1. Decompose: use the mature storyboard-design prompt (shot types, camera
//      reuse via cam_idx, audio + dialogue, composition, safety rules) to
//      split the scene into a list of shot briefs. Each shot's visual_desc
//      tags on-screen characters with `<Name>` angle brackets (required by
//      storyboard-design).
//   2. Render per panel: regex-extract the on-screen characters from
//      visual_desc, gather ALL of their reference images from the registry
//      into i2i's references.source[], and spell out in the prompt which image
//      maps to which character so the model fuses every on-screen character
//      into a single panel image. The i2i prompt uses the rich visual_desc
//      directly. Optionally, bestOfN runs meta_image-best-of-n to generate N
//      candidates and pick the best.
//
// Shares one storyboard-design prompt with meta_script2video: both read
// STORYBOARD_DESIGN_PROMPT from ../_shared/storyboard-design-prompt, which is
// the single source of truth for that prompt.
//
// Key precondition: the runtime must resolve `input.references` handles on
// meta SUB-steps, not just on top-level dispatches. This meta hands i2i a
// references.source array of handles it never resolves itself; each one has
// to become a real assetId at the sub-step's own dispatch boundary, scoped to
// the ledger the calling context belongs to. A runtime that only resolves
// references at the outermost call cannot run this meta.
//
// This meta has no assetNeeds of its own:
// character refs are handles that arrive in input.characters[].refs and are
// forwarded to the i2i sub-step's references.source, resolved at the sub-step
// boundary.

import { z } from 'zod'
import type { MetaPattern, ExecutionContext } from '@orchestral/core'
import {
  labelAsset,
  labelledAssetShape,
  resolvePrompts,
  sumCosts,
  toJsonSchemaCached,
  type LabelledAsset,
} from '../_shared/meta-utils'
import { boundedText, metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { imageToImage } from '../../atomic/image-to-image'
import { imageBestOfNMeta } from '../image-best-of-n'
import { STORYBOARD_DESIGN_PROMPT } from '../_shared/storyboard-design-prompt'

// ── input / output ──────────────────────────────────────────────────────

const CharacterSchema = z.object({
  name: z
    .string()
    .min(1, 'character name required')
    .describe(
      'The character\'s name. This is the key the storyboard references by name — it must match the `<Name>` angle-bracket tags the storyboard-design decomposition writes into each shot\'s visual_desc exactly (storyboard-design copies names verbatim from the supplied character list).',
    ),
  refs: z
    .array(z.string())
    .min(1, 'each character needs at least one reference image handle')
    // The CJK terms below are deliberate: `describe()` text is LLM-facing, and
    // these are the words users actually type for a character turnaround sheet
    // in those languages. Keeping them here lets the model match the slot from
    // a non-English request. Not stray text — do not "clean up".
    .describe(
      'Asset handles of this character\'s reference images (三视图 / 定妆图 / turnaround). All of them are fed into every panel the character appears in, so the model fuses a consistent identity across the storyboard.',
    ),
})

export const StoryboardInputSchema = z.object({
  scene: z
    .string()
    .min(1, 'scene required')
    .describe(
      'Scene / single-scene script the storyboard depicts. Fed to the storyboard-design decomposition as <SCRIPT>.',
    ),
  characters: z
    .array(CharacterSchema)
    .min(1, 'at least one character with reference images required')
    .describe(
      'Character registry: each character\'s name + reference image handles. This is the ONLY reliable name→reference mapping — the meta never guesses a character\'s images from asset names. The names are fed to the decomposition as <CHARACTERS> so it tags each shot\'s on-screen characters with the exact names.',
    ),
  userRequirement: z
    .string()
    .optional()
    .describe(
      'Optional storyboard-design control knob, fed as <USER_REQUIREMENT>: target audience, visual style (realistic / cartoon / …), desired shot count (e.g. "no more than 8 shots"), or other specific instructions (e.g. emphasize the characters\' actions).',
    ),
  bestOfN: z
    .number()
    .int()
    .min(2)
    .max(8)
    .optional()
    .describe(
      'When set (≥2), each panel renders N candidates via meta_image-best-of-n and a VLM picks the best. Omit for a single image-to-image render per panel.',
    ),
})
export type StoryboardInput = z.infer<typeof StoryboardInputSchema>

// A panel carries the shot's non-asset fields only. Its image rides in the
// output's top-level `assets[]` under the label `panel-<shotIndex>` — the
// model-facing projection passes nested fields through untouched, so an
// `assetIds` here would hand the model a raw id (see labelledAssetShape).
// String bounds follow the bounded output-field vocabulary; the patterns
// README, "Conventions", tables every one of them.
export const PanelSchema = z.object({
  shotIndex: z.number().int().min(0).describe('0-based panel order index.'),
  // 4 KiB: one shot's composition, not a shot list.
  visualDesc: boundedText(4_096).describe(
    'The shot\'s visual description (storyboard-design visual_desc).',
  ),
  // 2 KiB: a cue line or a few lines of dialogue.
  audioDesc: boundedText(2_048).describe(
    'The shot\'s audio cue / dialogue (storyboard-design audio_desc; may be empty).',
  ),
  camIdx: z
    .number()
    .int()
    .describe(
      'Shared camera-position index from storyboard-design — panels reusing a camera share this index.',
    ),
  // 128 per name: the registry's own `name` is what these are copied from.
  // The array's length is the shot's cast, which the audit cannot bound; it is
  // at most the input registry's size, since an unknown name fails closed.
  characterNames: z
    .array(boundedText(128))
    .describe(
      'Names of the on-screen characters extracted from this shot\'s visual_desc <Name> tags and rendered into the panel.',
    ),
})
/** @alpha */
export type StoryboardPanel = z.infer<typeof PanelSchema>

// Produced media rides in `assets[]` with a role `label` and nowhere else —
// see labelledAssetShape for why the projection needs it that way. `panels[]`
// is the structured storyboard the LLM reads back to reason about the
// sequence; a panel's image is the `panel-<shotIndex>` element of assets[].
export const StoryboardOutputSchema = z.object({
  panels: z
    .array(PanelSchema)
    .describe(
      'The storyboard panels, in narrative order. Panel i\'s image is the `panel-<i>` element of assets[].',
    ),
  assets: z
    .array(z.object(labelledAssetShape('image')))
    .describe(
      'Every produced panel image in panel order, labelled `panel-<shotIndex>` — one element per panel (a render that returned several images contributes several elements under the same label; bestOfN keeps only the winner). The host records these as the run\'s deliverables.',
    ),
  ...metaEnvelopeShape,
})
export type StoryboardOutput = z.infer<typeof StoryboardOutputSchema>

export const STORYBOARD_PATTERN_ID = 'meta_storyboard'

// storyboard-design [Output] shape — { storyboard: [ShotBrief] }. Mirrors
// meta_script2video's StoryboardResponseSchema / ShotBriefSchema so both metas
// parse the same decomposition contract.
export const ShotBriefSchema = z.object({
  idx: z.number().int(),
  is_last: z.boolean(),
  cam_idx: z.number().int(),
  visual_desc: z.string(),
  audio_desc: z.string(),
})
/** @alpha */
export type ShotBrief = z.infer<typeof ShotBriefSchema>
const StoryboardResponseSchema = z.object({
  storyboard: z
    .array(ShotBriefSchema)
    .min(1, 'storyboard needs at least one shot'),
})

// Tier-B fallback: when no enabled model can produce native structured output
// (or it returns malformed JSON), we re-ask in XML and strip it out. XML is far
// more robust than prompt-coaxed JSON on weak models — no brace balancing /
// quote escaping / code-fence wrapping. Field content is captured verbatim, so
// the `<Name>` character tags inside visual_desc are preserved (downstream
// extractCharacterNames needs them).
const STORYBOARD_XML_INSTRUCTION = `Output ONLY the storyboard as XML, no prose and no code fences, in exactly this structure:
<storyboard>
  <shot>
    <idx>0</idx>
    <is_last>false</is_last>
    <cam_idx>0</cam_idx>
    <visual_desc>shot composition; keep <Name> angle-bracket character tags verbatim</visual_desc>
    <audio_desc>audio cue / dialogue</audio_desc>
  </shot>
</storyboard>`

/** Strip the Tier-B XML envelope into ShotBrief[]. Per-field non-greedy
 *  extraction: inner `<Name>` tags inside visual_desc are plain text and are
 *  captured verbatim (they can never be a `</visual_desc>` close tag). */
function parseStoryboardXml(text: string): ShotBrief[] {
  const shots: ShotBrief[] = []
  for (const m of text.matchAll(/<shot>([\s\S]*?)<\/shot>/g)) {
    const body = m[1]!
    const field = (tag: string): string | undefined => {
      const fm = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)
      return fm ? fm[1] : undefined
    }
    shots.push(
      ShotBriefSchema.parse({
        idx: Number((field('idx') ?? '').trim()),
        is_last: (field('is_last') ?? '').trim() === 'true',
        cam_idx: Number((field('cam_idx') ?? '').trim()),
        visual_desc: (field('visual_desc') ?? '').trim(),
        audio_desc: (field('audio_desc') ?? '').trim(),
      }),
    )
  }
  if (shots.length === 0) {
    throw new Error(
      'STORYBOARD_XML_EMPTY: no <shot> elements parsed from XML fallback',
    )
  }
  return shots
}

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompt for meta_storyboard. This is meta_storyboard's own
 * copy of the shared storyboard-design prompt; its `storyboardDesign` override
 * key is independent of meta_script2video's identically-named key, so
 * overriding one does not affect the other.
 */
export const STORYBOARD_DEFAULT_PROMPTS = Object.freeze({
  storyboardDesign: STORYBOARD_DESIGN_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_storyboard. */
export type StoryboardPromptOverrides = Partial<
  Record<keyof typeof STORYBOARD_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_storyboard (prompt overrides only). */
export type StoryboardMetaInit = {
  prompts?: StoryboardPromptOverrides
}

/** @alpha */
export function createStoryboardMeta(
  init: StoryboardMetaInit = {},
): MetaPattern<StoryboardInput, StoryboardOutput> {
  const resolved = resolvePrompts(STORYBOARD_DEFAULT_PROMPTS, init.prompts)
  return {
    id: STORYBOARD_PATTERN_ID,
    kind: 'meta',
    searchHint:
      'generate a storyboard / shot sequence keeping characters consistent across panels',
    namespace: 'meta-pipelines',
    description:
      'Turn a scene + character reference sheets into a consistent multi-panel storyboard. Designs a professional shot-by-shot storyboard from the scene (shot types, camera reuse, composition), then renders each panel via image-to-image, automatically fusing the reference images of every character on screen so identities stay consistent across panels — including two characters sharing one shot. Use when you have character reference images and need a coherent multi-panel storyboard / shot sequence.',
    tool: {
      description:
        'Generate a multi-panel storyboard from a scene and character reference sheets, keeping each character visually consistent across panels. Designs the shots with a professional storyboard-design pass, then for every panel fuses ALL on-screen characters\' reference images into one image-to-image render (so two characters in the same shot both keep their identity — the failure mode of doing this by hand). Provide the scene, a character registry (name + reference image handles), and optionally a userRequirement (shot count, style, audience). Use when you have character reference images and want a coherent storyboard / shot sequence rather than a single image. Set bestOfN to render N candidates per panel and VLM-pick the best.',
      inputs: StoryboardInputSchema,
    },
    outputs: StoryboardOutputSchema,
    async compose(params, ctx): Promise<StoryboardOutput> {
      const { input } = params
      const startedAt = Date.now()

      // Name → reference handles. The registry is the single source of truth;
      // shots reference characters by the `<Name>` tags storyboard-design
      // writes into visual_desc, and we look up the handles here.
      const refsByName = new Map(
        input.characters.map((c) => [c.name, c.refs] as const),
      )

      // Stage 1 — design the storyboard (professional shot-by-shot pass).
      const { shots, cost: designCost } = await designStoryboard(
        ctx,
        input,
        resolved.storyboardDesign,
      )

      // Stage 2 — render each panel. Panels are independent, so fan them out in
      // parallel; the runtime caps actual concurrency. Each dispatch gets a
      // unique stepId — without it the stepCache would collapse panels that
      // happen to share a patternId+input into one (same reason best-of-n
      // sets candidate-${idx}).
      const rendered = await parallel(
        shots.map((shot, idx) =>
          renderPanel(ctx, input, shot, idx, refsByName),
        ),
      )

      return {
        panels: rendered.map((r) => r.panel),
        // Panel order is preserved: `parallel` keeps submission order, and
        // each panel's elements are already stamped `panel-<idx>`.
        assets: rendered.flatMap((r) => r.assets),
        cost: sumCosts([designCost, ...rendered.map((r) => r.cost)]),
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

type Ctx = ExecutionContext

/**
 * Stage 1 — design the storyboard via the storyboard-design prompt. Feeds the
 * scene as <SCRIPT>, the character roster as <CHARACTERS>, and the optional
 * userRequirement as <USER_REQUIREMENT>, then parses the {storyboard:[...]}
 * shot-brief list (visual_desc, audio_desc, cam_idx, ...).
 */
async function designStoryboard(
  ctx: Ctx,
  input: StoryboardInput,
  storyboardDesignPrompt: string,
): Promise<{ shots: ShotBrief[]; cost: number | null }> {
  const prompt = buildStoryboardPrompt(
    input.scene,
    input.characters,
    input.userRequirement,
  )
  // Tier A — native structured output. Wrap dispatch + parse in ONE try so
  // EITHER a dispatch failure (no structured-capable model survived the
  // fallback-walk) OR a malformed / wrong-shape JSON body drops to Tier B.
  try {
    const out = await textGeneration(
      ctx,
      {
        system: storyboardDesignPrompt,
        prompt,
        responseFormat: 'json',
        jsonSchema: toJsonSchemaCached(StoryboardResponseSchema),
      },
      { stepId: 'decompose-json' },
    )
    return {
      shots: StoryboardResponseSchema.parse(JSON.parse(out.text)).storyboard,
      cost: out.cost,
    }
  } catch (jsonErr) {
    const jsonReason = jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
    // Tier B — prompt-based XML on any text model (no structured cap needed).
    // Distinct stepId so the stepCache doesn't collapse it onto the json step.
    try {
      const out = await textGeneration(
        ctx,
        {
          system: storyboardDesignPrompt,
          prompt: `${prompt}\n\n${STORYBOARD_XML_INSTRUCTION}`,
          responseFormat: 'text',
        },
        { stepId: 'decompose-xml' },
      )
      return { shots: parseStoryboardXml(out.text), cost: out.cost }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `STORYBOARD_DECOMPOSE_FAILED: structured (json) and XML-fallback decomposition both failed (json: ${jsonReason}; xml: ${reason})`,
        { cause: err },
      )
    }
  }
}

/**
 * Build the storyboard-design user message: scene as <SCRIPT>, character names
 * as <CHARACTERS>, optional control knob as <USER_REQUIREMENT>. The registry
 * carries no feature text (just names + ref handles), so the character block
 * lists names — storyboard-design only needs them to tag on-screen characters
 * with exact `<Name>` markers, which is how we map back to refs.
 */
function buildStoryboardPrompt(
  scene: string,
  characters: ReadonlyArray<{ name: string }>,
  userRequirement: string | undefined,
): string {
  const chars = characters.map((c) => `- ${c.name}`).join('\n')
  const req = userRequirement
    ? `\n\n<USER_REQUIREMENT>\n${userRequirement}\n</USER_REQUIREMENT>`
    : ''
  return `<SCRIPT>\n${scene}\n</SCRIPT>\n\n<CHARACTERS>\n${chars}\n</CHARACTERS>${req}`
}

// storyboard-design encloses on-screen character names in angle brackets inside
// visual_desc (e.g. "<Alice> stands on the left"). We pull every `<...>` tag to
// learn which characters appear in a shot. Names can be CJK / contain spaces, so
// the capture is "anything but a closing bracket".
const NAME_TAG_RE = /<([^<>]+)>/g

/** Extract the on-screen character names tagged in a shot's visual_desc, in
 *  first-appearance order, de-duplicated. */
function extractCharacterNames(visualDesc: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const m of visualDesc.matchAll(NAME_TAG_RE)) {
    const name = m[1]!.trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Render one panel. Extracts the on-screen characters from the shot's
 * visual_desc `<Name>` tags, gathers every one's reference handles into the i2i
 * `source[]` slot (fail-closed on an unknown name), builds a prompt that tells
 * the model which source image is which character, and dispatches either a
 * single i2i or a best-of-n quality gate.
 */
async function renderPanel(
  ctx: Ctx,
  input: StoryboardInput,
  shot: ShotBrief,
  idx: number,
  refsByName: ReadonlyMap<string, readonly string[]>,
): Promise<{
  panel: StoryboardPanel
  assets: LabelledAsset<'image'>[]
  cost: number | null
}> {
  const characterNames = extractCharacterNames(shot.visual_desc)

  // Collect refs for every on-screen character, tracking which handle belongs
  // to which character so the prompt can label the source array by index, and
  // so the best-of-n judge can be told which character each reference depicts.
  const sourceRefs: string[] = []
  const refLabels: string[] = []
  const refNames: string[] = []
  for (const name of characterNames) {
    const refs = refsByName.get(name)
    if (!refs) {
      // fail-closed — a panel tagging a character the registry doesn't know is
      // exactly the silent-identity-loss bug this meta exists to prevent. The
      // storyboard-design pass is told to copy names verbatim from the roster,
      // so an unknown tag is a real mismatch worth surfacing.
      throw new Error(
        `STORYBOARD_UNKNOWN_CHARACTER: panel ${idx} references "${name}", ` +
          `which is not in the character registry (known: ${[...refsByName.keys()]
            .map((n) => `"${n}"`)
            .join(', ')})`,
      )
    }
    for (const ref of refs) {
      sourceRefs.push(ref)
      refLabels.push(`Reference image ${sourceRefs.length} = ${name}`)
      refNames.push(name)
    }
  }

  const prompt = buildPanelPrompt(shot.visual_desc, refLabels)

  // i2i.source is required (≥1 image to fuse). A panel that tagged no known
  // character has no source, and we deliberately do NOT silently degrade to
  // text-to-image — that would make the two render paths behave differently
  // and surprise the caller. Fail-closed: a panel needs at least one on-screen
  // character to render from its references.
  if (sourceRefs.length === 0) {
    throw new Error(
      `STORYBOARD_NO_SOURCE: panel ${idx} has no on-screen characters (no <Name> ` +
        `tag in its visual description), so there are no reference images to ` +
        `render from. Storyboard panels render via image-to-image and need at ` +
        `least one character's reference.`,
    )
  }

  const { assets, cost } =
    input.bestOfN !== undefined
      ? await renderBestOfN(ctx, prompt, sourceRefs, refNames, input.bestOfN, idx)
      : await renderSingle(ctx, prompt, sourceRefs, idx)

  return {
    panel: {
      shotIndex: idx,
      visualDesc: shot.visual_desc,
      audioDesc: shot.audio_desc,
      camIdx: shot.cam_idx,
      characterNames,
    },
    assets,
    cost,
  }
}

/** The label a panel's image(s) carry in the output's assets[]. */
const panelLabel = (idx: number) => `panel-${idx}`

/** Single image-to-image render — returns the produced asset(s), labelled, + cost. */
async function renderSingle(
  ctx: Ctx,
  prompt: string,
  sourceRefs: readonly string[],
  idx: number,
): Promise<{ assets: LabelledAsset<'image'>[]; cost: number | null }> {
  const out = await imageToImage(
    ctx,
    { prompt, references: { source: [...sourceRefs] } },
    { stepId: `panel-${idx}` },
  )
  // Symmetric with the best-of-n path's winner guard: an i2i that returns
  // zero assets would silently leave this panel image-less rather than fail.
  if (out.assets.length === 0) {
    throw new Error(
      `STORYBOARD_EMPTY_PANEL: panel ${idx} image-to-image returned no asset`,
    )
  }
  return {
    assets: out.assets.map((a) => labelAsset(a, 'image', panelLabel(idx))),
    cost: out.cost,
  }
}

/** Best-of-N quality gate — N i2i candidates, VLM picks the winner. */
async function renderBestOfN(
  ctx: Ctx,
  prompt: string,
  sourceRefs: readonly string[],
  refNames: readonly string[],
  n: number,
  idx: number,
): Promise<{ assets: LabelledAsset<'image'>[]; cost: number | null }> {
  // Hand the SAME character reference handles to the judge as ground truth, so
  // it scores each candidate on character consistency (this meta's whole point)
  // rather than description-fidelity alone. referenceHandles ride the same
  // LLM-facing handle channel the inner i2i uses; inside best-of-n they resolve
  // against the judge sub-step's (image-to-text) `source` assetNeeds and merge
  // into that slot AHEAD of the candidates, so the judge actually compares each
  // candidate against these references (not just the target text).
  // refDescriptions pairs each handle (by index) with the character it depicts.
  const out = await imageBestOfNMeta(
    ctx,
    {
      innerPatternId: 'image-to-image',
      innerInput: { prompt, references: { source: [...sourceRefs] } },
      n,
      targetDescription: prompt,
      referenceHandles: [...sourceRefs],
      refDescriptions: refNames.map((name) => `${name} reference`),
    },
    { stepId: `panel-${idx}` },
  )
  // The pick is the `winner`-labelled element of best-of-n's assets[]; it is
  // re-labelled for this panel, the losing candidates are not forwarded.
  const winner = out.assets.find((a) => a.label === 'winner')
  if (winner === undefined) {
    throw new Error(
      'storyboard: meta_image-best-of-n produced no asset labelled "winner"',
    )
  }
  return {
    assets: [labelAsset(winner, 'image', panelLabel(idx))],
    cost: out.cost,
  }
}

/**
 * Build the per-panel i2i prompt. The visual_desc (rich storyboard-design shot
 * description) is the body; the reference-image labels are the load-bearing
 * bit: the model sees the source images in array order, so we spell out which
 * image is which character ("Reference image 1 = 张院君, reference image 2 = 仙姬").
 * This is exactly what a human does by hand to keep two same-frame characters
 * from collapsing into one identity — here it is automatic.
 */
function buildPanelPrompt(
  visualDesc: string,
  refLabels: readonly string[],
): string {
  const parts = [visualDesc]
  if (refLabels.length > 0) {
    parts.push(
      `Use the provided reference images to keep each character consistent. ${refLabels.join('; ')}.`,
    )
  }
  return parts.join('\n\n')
}
