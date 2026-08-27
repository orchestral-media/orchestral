// The shipped first-party Pattern id catalog, as data.
//
// Every id already exists as a per-module constant; this is the only place
// that says which of them the package SHIPS. Anything needing "the whole
// first-party catalog" — @orchestral/agent's orchestrator tool list, a host
// registering a subset, a drift gate against the `orchestral` manifest — reads
// this instead of re-typing the literals: a second hand-written copy is what
// let the orchestrator's tool list drift once already.
//
// Grouped by the `kind` the package.json manifest declares, NOT by source
// directory: `meta_image-to-image-via-caption` is authored under atomic/ but
// ships as kind:'meta', because the id prefix is what routes it to the
// meta-pipelines namespace. Order inside each group is the manifest's, so
// splicing the groups yields a stable catalog order a reviewer can diff.
//
// Imported from the leaf modules rather than from './index' (which imports
// this file). The whole catalog is string constants, so a bundler that keeps
// the shipped factories out of a consumer's build still can.

import type { AtomicPatternId, MetaPatternId } from '@orchestral/core'

import { AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID } from './atomic/automatic-speech-recognition'
import { IMAGE_TO_IMAGE_PATTERN_ID } from './atomic/image-to-image'
import { IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID } from './atomic/image-to-image-via-caption'
import { IMAGE_TO_TEXT_PATTERN_ID } from './atomic/image-to-text'
import { IMAGE_TO_VIDEO_PATTERN_ID } from './atomic/image-to-video'
import { TEXT_GENERATION_PATTERN_ID } from './atomic/text-generation'
import { TEXT_TO_AUDIO_PATTERN_ID } from './atomic/text-to-audio'
import { TEXT_TO_IMAGE_PATTERN_ID } from './atomic/text-to-image'
import { TEXT_TO_SPEECH_PATTERN_ID } from './atomic/text-to-speech'
import { TEXT_TO_VIDEO_PATTERN_ID } from './atomic/text-to-video'
import { VIDEO_TO_VIDEO_PATTERN_ID } from './atomic/video-to-video'
import { EXPLAINER_SHORT_PATTERN_ID } from './meta/explainer-short'
import { IMAGE_BEST_OF_N_PATTERN_ID } from './meta/image-best-of-n'
import { PLAN_PATTERN_ID } from './meta/plan'
import { PRODUCT_AD_SHORT_PATTERN_ID } from './meta/product-ad-short'
import { PRODUCT_PHOTO_PACK_PATTERN_ID } from './meta/product-photo-pack'
import { SCRIPT2VIDEO_PATTERN_ID } from './meta/script2video'
import { STORYBOARD_PATTERN_ID } from './meta/storyboard'
import { UGC_TESTIMONIAL_PATTERN_ID } from './meta/ugc-testimonial'

const ATOMIC_PATTERN_IDS: readonly AtomicPatternId[] = Object.freeze([
  TEXT_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_TEXT_PATTERN_ID,
  TEXT_TO_VIDEO_PATTERN_ID,
  IMAGE_TO_VIDEO_PATTERN_ID,
  VIDEO_TO_VIDEO_PATTERN_ID,
  TEXT_TO_SPEECH_PATTERN_ID,
  TEXT_TO_AUDIO_PATTERN_ID,
  AUTOMATIC_SPEECH_RECOGNITION_PATTERN_ID,
  TEXT_GENERATION_PATTERN_ID,
])

const META_PATTERN_IDS: readonly MetaPatternId[] = Object.freeze([
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  SCRIPT2VIDEO_PATTERN_ID,
  IMAGE_BEST_OF_N_PATTERN_ID,
  STORYBOARD_PATTERN_ID,
  PRODUCT_AD_SHORT_PATTERN_ID,
  PRODUCT_PHOTO_PACK_PATTERN_ID,
  UGC_TESTIMONIAL_PATTERN_ID,
  EXPLAINER_SHORT_PATTERN_ID,
  PLAN_PATTERN_ID,
])

/**
 * @alpha
 * The ids this package ships, grouped by declared kind. Frozen at both levels:
 * consumers splice the groups into their own lists, and a shared catalog that
 * one consumer can splice-in-place is a catalog every other consumer has to
 * distrust.
 */
export const FIRST_PARTY_PATTERN_IDS: Readonly<{
  atomic: readonly AtomicPatternId[]
  meta: readonly MetaPatternId[]
}> = Object.freeze({
  atomic: ATOMIC_PATTERN_IDS,
  meta: META_PATTERN_IDS,
})
