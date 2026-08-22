import { describe, expect, it } from 'vitest'

import {
  createAutomaticSpeechRecognitionPattern,
  createExplainerShortMeta,
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createImageToVideoPattern,
  createProductAdShortMeta,
  createProductPhotoPackMeta,
  createTextGenerationPattern,
  createTextToAudioPattern,
  createTextToImagePattern,
  createTextToSpeechPattern,
  createTextToVideoPattern,
  createUgcTestimonialMeta,
  createVideoToVideoPattern,
} from '../index'

// The deliverable metas take host-injected deps, but only dereference them
// inside compose (construction touches deps.prompts alone, which tolerates
// undefined) — an empty stub is enough to pin the declared namespace.
const stubDeps = {} as never

// Every first-party Pattern must explicitly declare its namespace.
// `find_pattern` partitions search by namespace (kind=atomic + modality
// filter), and AgentPattern.loop.toolNamespaces selects which namespaces a
// sub-agent sees — both demand explicit declaration on the Pattern itself
// rather than `inferNamespace` heuristic fallback.
//
// This test pins the namespace assignment per Pattern. Adding a new
// first-party Pattern requires touching this test, which is the desired
// gate.

describe('first-party Pattern.namespace', () => {
  it.each([
    [createTextToImagePattern(), 'image-gen'],
    [createImageToImagePattern(), 'image-gen'],
    [createTextToVideoPattern(), 'video-gen'],
    [createImageToVideoPattern(), 'video-gen'],
    [createVideoToVideoPattern(), 'video-gen'],
    [createTextToSpeechPattern(), 'audio-gen'],
    [createTextToAudioPattern(), 'audio-gen'],
    [createAutomaticSpeechRecognitionPattern(), 'audio-gen'],
    [createTextGenerationPattern(), 'text-gen'],
    [createImageToTextPattern(), 'text-gen'],
    [createImageToImageViaCaptionPattern(), 'meta-pipelines'],
    [createExplainerShortMeta(stubDeps), 'meta-pipelines'],
    [createProductAdShortMeta(stubDeps), 'meta-pipelines'],
    [createProductPhotoPackMeta(stubDeps), 'meta-pipelines'],
    [createUgcTestimonialMeta(stubDeps), 'meta-pipelines'],
  ])('$id -> namespace=$1', (pattern, expectedNamespace) => {
    expect(pattern.namespace).toBe(expectedNamespace)
  })

  it('every first-party Pattern declares a namespace (no inferNamespace fallback)', () => {
    const patterns = [
      createTextToImagePattern(),
      createImageToImagePattern(),
      createTextToVideoPattern(),
      createImageToVideoPattern(),
      createVideoToVideoPattern(),
      createTextToSpeechPattern(),
      createTextToAudioPattern(),
      createAutomaticSpeechRecognitionPattern(),
      createTextGenerationPattern(),
      createImageToTextPattern(),
      createImageToImageViaCaptionPattern(),
      createExplainerShortMeta(stubDeps),
      createProductAdShortMeta(stubDeps),
      createProductPhotoPackMeta(stubDeps),
      createUgcTestimonialMeta(stubDeps),
    ]
    for (const p of patterns) {
      expect(p.namespace, `Pattern ${p.id} must declare namespace`).toBeDefined()
    }
  })
})
