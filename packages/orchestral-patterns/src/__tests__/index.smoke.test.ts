import { describe, expect, it } from 'vitest'
import * as patterns from '../index'

describe('@orchestral/patterns public surface', () => {
  it('exports the 10 atomic + via-caption + 7 meta factories', () => {
    const factories = [
      'createTextToImagePattern','createImageToImagePattern','createImageToTextPattern',
      'createTextToVideoPattern','createImageToVideoPattern','createVideoToVideoPattern',
      'createTextToSpeechPattern','createTextToAudioPattern','createAutomaticSpeechRecognitionPattern',
      'createTextGenerationPattern','createImageToImageViaCaptionPattern',
      'createImageBestOfNMeta','createStoryboardMeta','createScript2VideoMeta',
      'createProductAdShortMeta','createUgcTestimonialMeta','createExplainerShortMeta',
      'createProductPhotoPackMeta',
    ] as const
    for (const f of factories) {
      expect(typeof (patterns as Record<string, unknown>)[f]).toBe('function')
    }
  })
})
