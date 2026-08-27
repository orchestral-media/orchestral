// The catalog this host registers: everything `@orchestral/patterns` ships,
// plus the six long-form patterns kept as source under ./patterns. One
// function, so main.ts and the smoke test cannot disagree about what
// "everything" is.
//
// The six are the ViMax-derived novel → video pipeline:
//
//   meta_script-planning    idea → planned script (router + branch template)
//   meta_prose-chunking     long prose → compressed narrative (∥ per chunk)
//   meta_novel-to-events    prose → causal chain of plot events (sequential)
//   meta_event-to-script    one event → ≤5 polished scene screenplays
//   meta_idea2video         idea → multi-scene video (nests meta_script2video)
//   agent_long-form-video   the director that drives the chain per event
//
// They compile against the public `@orchestral/*` surface alone: the shared
// authoring helpers (`sumCosts`, `resolvePrompts`, `labelledAssetShape`, …)
// and the typed atomic functions (`textGeneration`, `script2videoMeta`) are
// the package's exports, not a copy of its internals.

import type { Alternative, Pattern, PatternRegistry } from '@orchestral/core'
import {
  createAutomaticSpeechRecognitionPattern,
  createExplainerShortMeta,
  createImageBestOfNMeta,
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createImageToVideoPattern,
  createProductAdShortMeta,
  createProductPhotoPackMeta,
  createScript2VideoMeta,
  createStoryboardMeta,
  createTextGenerationPattern,
  createTextToAudioPattern,
  createTextToImagePattern,
  createTextToSpeechPattern,
  createTextToVideoPattern,
  createUgcTestimonialMeta,
  createVideoToVideoPattern,
  type MetaCommonDeps,
} from '@orchestral/patterns'
import { createLongFormVideoAgent } from './patterns/agent-long-form-video'
import { createEventToScriptMeta } from './patterns/event-to-script'
import { createIdea2VideoMeta } from './patterns/idea2video'
import { createNovelToEventsMeta } from './patterns/novel-to-events'
import { createProseChunkingMeta } from './patterns/prose-chunking'
import { createScriptPlanningMeta } from './patterns/script-planning'

/**
 * The host operations the registered metas Pick from. Between them the
 * shipped deliverable metas use every op in `MetaCommonDeps`, and the
 * long-form chain adds none of its own: `meta_idea2video` takes the same
 * `concatVideos` that `meta_script2video` does. The director agent's
 * `concat_videos` TOOL is a separate host obligation — see the README.
 */
export type LongFormHostOps = MetaCommonDeps

/** The six patterns this example keeps as source, in pipeline order. */
export const LONG_FORM_PATTERN_IDS = [
  'meta_script-planning',
  'meta_prose-chunking',
  'meta_novel-to-events',
  'meta_event-to-script',
  'meta_idea2video',
  'agent_long-form-video',
] as const

export interface RegisteredCatalog {
  /** Ids registered from `@orchestral/patterns`, in registration order. */
  shipped: string[]
  /** Ids registered from this example's ./patterns, in registration order. */
  longForm: string[]
}

/**
 * Register the shipped catalog and the long-form six into `registry`.
 * Construction only — nothing dispatches, and none of the host ops in `ops`
 * is invoked until a meta's compose() runs.
 */
export function registerCatalog(
  registry: PatternRegistry,
  ops: LongFormHostOps,
): RegisteredCatalog {
  const add = <I, O>(
    pattern: Pattern<I, O> & { alternatives?: readonly Alternative<I, O>[] },
  ): string => {
    registry.register(pattern)
    return pattern.id
  }

  const shipped = [
    // the ten atomics
    add(createTextToImagePattern()),
    add(createImageToImagePattern()),
    add(createImageToTextPattern()),
    add(createTextToVideoPattern()),
    add(createImageToVideoPattern()),
    add(createVideoToVideoPattern()),
    add(createTextToSpeechPattern()),
    add(createTextToAudioPattern()),
    add(createAutomaticSpeechRecognitionPattern()),
    add(createTextGenerationPattern()),
    // image-to-image's only Alternative target
    add(createImageToImageViaCaptionPattern()),
    // the seven shipped metas
    add(createImageBestOfNMeta()),
    add(createStoryboardMeta()),
    add(createScript2VideoMeta(ops)),
    add(createProductAdShortMeta(ops)),
    add(createUgcTestimonialMeta(ops)),
    add(createExplainerShortMeta(ops)),
    add(createProductPhotoPackMeta()),
  ]

  const longForm = [
    add(createScriptPlanningMeta()),
    add(createProseChunkingMeta()),
    add(createNovelToEventsMeta()),
    add(createEventToScriptMeta()),
    add(createIdea2VideoMeta(ops)),
    add(createLongFormVideoAgent()),
  ]

  return { shipped, longForm }
}
