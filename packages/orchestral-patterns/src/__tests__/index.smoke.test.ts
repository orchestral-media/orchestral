import { describe, expect, it } from 'vitest'
import * as patterns from '../index'

describe('@orchestral/patterns public surface', () => {
  it('exports all 11 atomic + 8 meta factories', () => {
    const factories = [
      'createTextToImagePattern','createImageToImagePattern','createImageToTextPattern',
      'createTextToVideoPattern','createImageToVideoPattern','createVideoToVideoPattern',
      'createTextToSpeechPattern','createTextToAudioPattern','createAutomaticSpeechRecognitionPattern',
      'createTextGenerationPattern','createImageToImageViaCaptionPattern',
      'createScriptPlanningMeta','createReferenceImageCascadeMeta','createScript2VideoMeta',
      'createIdea2VideoMeta','createNovelToEventsMeta','createEventToScriptMeta',
      'createImageBestOfNMeta','createProseChunkingMeta',
    ] as const
    for (const f of factories) {
      expect(typeof (patterns as Record<string, unknown>)[f]).toBe('function')
    }
  })
})
