import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_BLOCKLIST,
  inferNamespace,
  resolveNamespace,
} from '../catalog'

describe('inferNamespace', () => {
  it.each([
    ['agent_foo', 'sub-agents'],
    ['meta_compose', 'meta-pipelines'],
    ['text-generation', 'text-gen'],
    ['image-to-text', 'text-gen'],
    ['summarization', 'text-gen'],
    ['translation', 'text-gen'],
    ['text-to-image', 'image-gen'],
    ['image-to-image', 'image-gen'],
    ['image-segmentation', 'image-gen'],
    ['text-to-video', 'video-gen'],
    ['image-to-video', 'video-gen'],
    ['video-to-video', 'video-gen'],
    ['text-to-speech', 'audio-gen'],
    ['text-to-audio', 'audio-gen'],
    ['audio-to-audio', 'audio-gen'],
    ['automatic-speech-recognition', 'audio-gen'],
  ])('infers %s -> %s', (id, expected) => {
    expect(inferNamespace(id)).toBe(expected)
  })

  it.each([['unknown-id'], ['embedding'], ['some-vendor-thing']])(
    'falls back to uncategorized for %s rather than guessing a modality',
    (id) => {
      expect(inferNamespace(id)).toBe('uncategorized')
    },
  )
})

describe('resolveNamespace', () => {
  it('prefers the declared namespace', () => {
    expect(resolveNamespace('text-to-image', 'video-gen')).toBe('video-gen')
  })

  it('infers when nothing was declared', () => {
    expect(resolveNamespace('text-to-image', undefined)).toBe('image-gen')
  })
})

describe('DEFAULT_SUBAGENT_BLOCKLIST', () => {
  it('blocks the agent_ id prefix', () => {
    expect(DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes).toContain('agent_')
  })
})
