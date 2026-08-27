import { describe, expect, it } from 'vitest'

import type { PatternId } from '../foundational'
import {
  DEFAULT_SUBAGENT_BLOCKLIST,
  inferNamespace,
  matchSubagentBlocklist,
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

describe('matchSubagentBlocklist', () => {
  it('names which half of the default blocklist matched, and says null when neither did', () => {
    // The return value is the `matched` field `job:tool-rejected` already
    // reports — the guards name the half that fired instead of recomputing it.
    expect(matchSubagentBlocklist('agent_orchestrator')).toBe('prefix')
    expect(matchSubagentBlocklist('meta_script2video')).toBeNull()
    expect(matchSubagentBlocklist('text-to-image')).toBeNull()
  })

  it('judges against an injected blocklist, so widening the default stays one function', () => {
    // The three runtime call sites pass no second argument. The parameter is
    // what keeps a host that needs a different list from writing a fourth
    // hand-inlined copy of the same two lines.
    const blocklist = {
      idPrefixes: ['sys_'],
      patternIds: ['text-to-image' as PatternId],
    }
    expect(matchSubagentBlocklist('sys_probe', blocklist)).toBe('prefix')
    expect(matchSubagentBlocklist('text-to-image', blocklist)).toBe('id')
    expect(matchSubagentBlocklist('agent_orchestrator', blocklist)).toBeNull()
  })

  it('prefers "prefix" when both halves match', () => {
    // An id can be both; the prefix is the broader statement about why it is
    // refused, and it is the answer the copied code gave, so the reported
    // `matched` byte does not change with this refactor.
    const blocklist = {
      idPrefixes: ['agent_'],
      patternIds: ['agent_orchestrator' as PatternId],
    }
    expect(matchSubagentBlocklist('agent_orchestrator', blocklist)).toBe('prefix')
  })

  it('is the executable spelling of what DEFAULT_SUBAGENT_BLOCKLIST documents', () => {
    for (const prefix of DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes) {
      expect(matchSubagentBlocklist(`${prefix}anything`)).toBe('prefix')
    }
    for (const id of DEFAULT_SUBAGENT_BLOCKLIST.patternIds) {
      expect(matchSubagentBlocklist(id)).not.toBeNull()
    }
  })
})
