// Every shipped meta that runs steps concurrently derives the same keys
// whichever order those steps settle in.
//
// A step's durable key is its path in the dispatch tree — its name, or its
// position among its compose's unnamed calls to the same pattern. A position
// taken in the order calls are REACHED is only stable if they are reached in
// the same order every run: calls written inline in `parallel([...])` are, and
// calls made after an `await` inside concurrent branches are not — they are
// reached in completion order, and a resubmit that finishes in another order
// pays for them again. This guard runs each meta twice on a real runtime whose
// model calls settle oldest-first, then newest-first, and requires the same
// multiset of keys from both.
//
// The comparison is on each child row's derived `idempotencyKey`, not on its
// bare path. A permutation leaves the multiset of paths alone — the steps
// still number #0…#n-1 — and only moves which input sits at which number; the
// derived key hashes the path together with the step's pattern, input and
// assets, so it sees exactly that pairing. The mocks answer as pure functions
// of their input, so nothing else can make two runs differ.
//
// Inputs and text scripts are the ones each meta's own test file uses.

import { describe, expect, it } from 'vitest'

import {
  createExplainerShortMeta,
  EXPLAINER_SHORT_DEFAULT_PROMPTS,
  ExplainerShortInputSchema,
} from '../meta/explainer-short'
import { createImageBestOfNMeta, ImageBestOfNInputSchema } from '../meta/image-best-of-n'
import {
  createProductAdShortMeta,
  PRODUCT_AD_SHORT_DEFAULT_PROMPTS,
  ProductAdShortInputSchema,
} from '../meta/product-ad-short'
import {
  createProductPhotoPackMeta,
  PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS,
  ProductPhotoPackInputSchema,
} from '../meta/product-photo-pack'
import {
  createScript2VideoMeta,
  SCRIPT2VIDEO_DEFAULT_PROMPTS,
  ScriptToVideoInputSchema,
} from '../meta/script2video'
import {
  createStoryboardMeta,
  STORYBOARD_DEFAULT_PROMPTS,
  StoryboardInputSchema,
} from '../meta/storyboard'
import {
  createUgcTestimonialMeta,
  UGC_TESTIMONIAL_DEFAULT_PROMPTS,
  UgcTestimonialInputSchema,
} from '../meta/ugc-testimonial'
import { runInOrder, type ChildRow, type OrderHostInit, type OrderRun } from './helpers/order-host'

const SESSION = 'sess-order-independence'

type Setup<I, O> = Omit<OrderHostInit<I, O>, 'sessionId'>

/** Identity, so each setup infers its meta's own input and output types. */
const setup = <I, O>(s: Setup<I, O>): Setup<I, O> => s

function promptOf(spec: ChildRow['spec']): string {
  const input = spec.input as { prompt?: unknown; text?: unknown } | null
  const p = input?.prompt ?? input?.text
  return typeof p === 'string' ? p : ''
}

/** A child, readably: its pattern and the first and last lines of what it was asked. */
function describeChild(c: ChildRow): string {
  const lines = promptOf(c.spec).trim().split('\n').filter((l) => l.trim() !== '')
  const first = (lines[0] ?? '').slice(0, 40)
  const last = (lines.at(-1) ?? '').slice(0, 40)
  return `${c.spec.patternId}[${lines.length > 1 ? `${first} … ${last}` : first}]`
}

const keysOf = (run: OrderRun): string[] => run.children.map((c) => c.idempotencyKey).sort()

/** Which children's keys only one of the two runs derived — the failure's explanation. */
function moved(a: OrderRun, b: OrderRun): string {
  const only = (x: OrderRun, y: OrderRun) => {
    const other = new Set(y.children.map((c) => c.idempotencyKey))
    return x.children.filter((c) => !other.has(c.idempotencyKey)).map(describeChild)
  }
  return (
    'child idempotency keys moved with the settle order — ' +
    `only under ${a.order}: ${only(a, b).join(', ') || 'none'}; ` +
    `only under ${b.order}: ${only(b, a).join(', ') || 'none'}`
  )
}

async function runTwice<I, O>(s: Setup<I, O>): Promise<void> {
  const init: OrderHostInit<I, O> = { ...s, sessionId: SESSION }
  const fifo = await runInOrder(init, 'fifo')
  const lifo = await runInOrder(init, 'lifo')

  for (const run of [fifo, lifo]) {
    expect({ order: run.order, status: run.root.status, error: run.root.error }).toEqual({
      order: run.order,
      status: 'done',
      error: null,
    })
  }
  // The second run really was reordered; agreement between two identical
  // schedules would prove nothing.
  expect(lifo.released).not.toEqual(fifo.released)
  expect(keysOf(lifo), moved(fifo, lifo)).toEqual(keysOf(fifo))
}

// ── meta_script2video ──────────────────────────────────────────────────────

// The narrator is off screen, so `visible` is [Alice, Bob] while the idx the
// model wrote for them is 1 and 2: a portrait named after `c.idx` instead of
// the character's position in `visible` does not pass the name pin below.
const NARRATOR = {
  idx: 0,
  identifierInScene: 'the narrator',
  staticFeatures: 'unseen',
  dynamicFeatures: '',
  isVisible: false,
}
const ALICE = {
  idx: 1,
  identifierInScene: 'Alice',
  staticFeatures: 'short hair',
  dynamicFeatures: 'green dress',
  isVisible: true,
}
const BOB = {
  idx: 2,
  identifierInScene: 'Bob',
  staticFeatures: 'tall',
  dynamicFeatures: 'blue shirt',
  isVisible: true,
}

const s2vShot = (idx: number, cam_idx: number, visual_desc: string, is_last = false) => ({
  idx,
  is_last,
  cam_idx,
  visual_desc,
  audio_desc: '',
})

const visualDescOf = (prompt: string): string =>
  /<VISUAL_DESC>\n([\s\S]*?)\n<\/VISUAL_DESC>/.exec(prompt)?.[1] ?? ''

const S2V = SCRIPT2VIDEO_DEFAULT_PROMPTS

// Two visible characters and a confirmed render gate: Stage 5 renders each
// character's front, then that character's side ∥ back from it, so the side
// and back calls are reached in the order the fronts finish.
const SCRIPT2VIDEO = setup({
  meta: (deps) => createScript2VideoMeta(deps),
  text: {
    [S2V.storyboardDesign]: {
      storyboard: [s2vShot(0, 0, 'shot A'), s2vShot(1, 0, 'shot B', true)],
    },
    [S2V.shotVisualDecomposition]: (prompt: string) => ({
      ff_desc: `first frame of ${visualDescOf(prompt)}`,
      ff_vis_char_idxs: [1, 2],
      lf_desc: `last frame of ${visualDescOf(prompt)}`,
      lf_vis_char_idxs: [1, 2],
      motion_desc: `pan across ${visualDescOf(prompt)}`,
      variation_type: 'small',
    }),
    [S2V.cameraTreeConstruction]: {
      camera_parent_items: [
        {
          cam_idx: 0,
          parent_cam_idx: null,
          parent_shot_idx: null,
          is_parent_fully_covers_child: null,
          missing_info: null,
        },
      ],
    },
  },
  input: ScriptToVideoInputSchema.parse({
    sceneScript: 'a short scene',
    characters: [NARRATOR, ALICE, BOB],
    confirmBeforeRender: true,
  }),
})

// ── meta_storyboard ────────────────────────────────────────────────────────

const sbShot = (idx: number, visual_desc: string, is_last = false) => ({
  idx,
  is_last,
  cam_idx: 0,
  visual_desc,
  audio_desc: '',
})

// Two panels, each a nested best-of-n whose judge runs once its own
// candidates are in.
const STORYBOARD = setup({
  meta: () => createStoryboardMeta(),
  nested: (registry) => registry.register(createImageBestOfNMeta()),
  text: {
    [STORYBOARD_DEFAULT_PROMPTS.storyboardDesign]: {
      storyboard: [sbShot(0, '<张院君> portrait'), sbShot(1, '<仙姬> portrait', true)],
    },
  },
  input: StoryboardInputSchema.parse({
    scene: 'two beats, quality-gated',
    characters: [
      { name: '张院君', refs: ['h-zhang-front', 'h-zhang-side'] },
      { name: '仙姬', refs: ['h-xianji'] },
    ],
    bestOfN: 2,
  }),
})

// ── the others ─────────────────────────────────────────────────────────────

const IMAGE_BEST_OF_N = setup({
  meta: () => createImageBestOfNMeta(),
  text: {},
  input: ImageBestOfNInputSchema.parse({
    innerPatternId: 'text-to-image',
    innerInput: { prompt: 'a knight', n: 1 },
    n: 3,
    targetDescription: 'a knight in shining armor',
  }),
})

const PRODUCT_PHOTO_PACK = setup({
  meta: () => createProductPhotoPackMeta(),
  text: {
    [PRODUCT_PHOTO_PACK_DEFAULT_PROMPTS.productPhotoPack]: {
      slots: ['hero', 'lifestyle', 'macro'].map((name, i) => ({ name, prompt: `prompt-${i}` })),
    },
  },
  input: ProductPhotoPackInputSchema.parse({ brief: 'ceramic coffee mug', maxSlots: 3 }),
})

const EXPLAINER_SHORT = setup({
  meta: (deps) => createExplainerShortMeta(deps),
  text: {
    [EXPLAINER_SHORT_DEFAULT_PROMPTS.explainerScenes]: {
      scenes: (['hook', 'concept', 'cta'] as const).map((type, i) => ({
        type,
        narration: `narration ${i}`,
        visual: `visual ${i}`,
      })),
    },
  },
  input: ExplainerShortInputSchema.parse({ topic: 'photosynthesis', sceneCount: 3, assemble: true }),
})

const PRODUCT_AD_SHORT = setup({
  meta: (deps) => createProductAdShortMeta(deps),
  text: {
    [PRODUCT_AD_SHORT_DEFAULT_PROMPTS.heroPrompts]: { prompts: ['p1', 'p2', 'p3'] },
  },
  input: ProductAdShortInputSchema.parse({
    brief: 'a sleek water bottle',
    variantCount: 3,
    withMusic: true,
  }),
})

const UGC_TESTIMONIAL = setup({
  meta: (deps) => createUgcTestimonialMeta(deps),
  text: {
    [UGC_TESTIMONIAL_DEFAULT_PROMPTS.ugcScript]: {
      script: 'I love this blender.',
      shots: [{ motion: 'slow push-in' }, { motion: 'slight reframe' }, { motion: 'handheld zoom' }],
    },
  },
  input: UgcTestimonialInputSchema.parse({
    product: 'Acme Blender',
    targetSeconds: 20,
    shots: 3,
    subtitles: true,
  }),
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('a shipped meta derives the same keys whichever order its steps settle in', () => {
  it('meta_script2video', async () => {
    await runTwice(SCRIPT2VIDEO)
  })

  it('meta_storyboard with bestOfN', async () => {
    await runTwice(STORYBOARD)
  })

  it('meta_image-best-of-n', async () => {
    await runTwice(IMAGE_BEST_OF_N)
  })

  it('meta_product-photo-pack', async () => {
    await runTwice(PRODUCT_PHOTO_PACK)
  })

  it('meta_explainer-short', async () => {
    await runTwice(EXPLAINER_SHORT)
  })

  it('meta_product-ad-short', async () => {
    await runTwice(PRODUCT_AD_SHORT)
  })

  it('meta_ugc-testimonial', async () => {
    await runTwice(UGC_TESTIMONIAL)
  })

  it('meta_script2video names each character portrait view by the character position', async () => {
    // Newest-first, so Bob's front settles before Alice's: a name taken from
    // the order of settling would put Bob at 0.
    const run = await runInOrder({ ...SCRIPT2VIDEO, sessionId: SESSION }, 'lifo')
    expect(run.root.status).toBe('done')

    const views = [S2V.portraitFront, S2V.portraitSide, S2V.portraitBack]
    const portraits = run.children.filter((c) => views.some((v) => promptOf(c.spec).startsWith(v)))
    const characterOf = (c: ChildRow) =>
      [...promptOf(c.spec).matchAll(/^Character: (.+)$/gm)].at(-1)?.[1]

    expect(Object.fromEntries(portraits.map((c) => [String(c.spec.stepKey), characterOf(c)]))).toEqual({
      'portrait-front-0': 'Alice',
      'portrait-side-0': 'Alice',
      'portrait-back-0': 'Alice',
      'portrait-front-1': 'Bob',
      'portrait-side-1': 'Bob',
      'portrait-back-1': 'Bob',
    })
  })
})
