// Slot-vocabulary indexing regression test.
//
// The deleted variant axis used to carry capability sub-mode terminology via
// per-variant `tool.description` strings. That vocabulary is now SSOT in
// `assetNeeds[*].slot` names and `assetNeeds[*].description` prose.
// Verified vocabulary: IP-Adapter / InstantID / inpaint / outpaint /
// voice-clone / audio-synthesis / etc.
// This test verifies BM25 indexes that vocabulary so queries like
// `find_pattern({query: 'IP-Adapter'})` still rank correctly.

import { describe, expect, it } from 'vitest'

import { silentDiagnosticsLogger, PatternRegistry, type Pattern } from '@orchestral/core'
import { PatternSearchIndex } from '@orchestral/discovery'
import {
  createTextToImagePattern,
  createImageToImagePattern,
  createImageToVideoPattern,
  createTextToSpeechPattern,
  createTextGenerationPattern,
} from '../index'

function freshIndex(patterns: readonly Pattern[]): PatternSearchIndex {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p as never)
  return new PatternSearchIndex(registry)
}

describe('slot vocabulary flows into BM25 toolDescriptions (SSOT: assetNeeds slot descriptions)', () => {
  it("query 'IP-Adapter' surfaces text-to-image (term in reference slot description)", () => {
    // 'IP-Adapter' lives in t2i assetNeeds[reference].description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
      createTextToSpeechPattern() as unknown as Pattern,
    ])
    const hits = index.search('IP-Adapter', {}, 5)
    expect(hits.map((p) => p.id)).toContain('text-to-image')
  })

  it("query 'InstantID' surfaces text-to-image (term in reference slot description)", () => {
    // 'InstantID' appears in t2i assetNeeds[reference].description — proves the
    // slot-description path is the load-bearing one post-capabilities deletion.
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createImageToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('InstantID', {}, 5)
    expect(hits.map((p) => p.id)).toContain('text-to-image')
  })

  it("query 'inpaint' surfaces image-to-image (term in mask slot description)", () => {
    // 'inpaint' lives in i2i assetNeeds[mask].description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createImageToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('inpaint', {}, 5)
    expect(hits.map((p) => p.id)).toContain('image-to-image')
  })

  it("query 'mask' surfaces image-to-image (slot name in assetNeeds)", () => {
    // 'mask' is both a slot name and appears in i2i assetNeeds[mask].description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createImageToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('mask', {}, 5)
    expect(hits.map((p) => p.id)).toContain('image-to-image')
  })

  it("query 'outpaint' surfaces image-to-image (term in source slot description)", () => {
    // 'outpaint' lives in i2i assetNeeds[source].description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createImageToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('outpaint', {}, 5)
    expect(hits.map((p) => p.id)).toContain('image-to-image')
  })

  it("query 'clone' surfaces text-to-speech (term in voiceClone slot description)", () => {
    // 'clone' lives in tts assetNeeds[voiceClone].description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createTextToSpeechPattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('clone', {}, 5)
    expect(hits.map((p) => p.id)).toContain('text-to-speech')
  })

  it("query 'voice' surfaces text-to-speech (term in tool description)", () => {
    // 'voice' lives in tts primary tool description AND assetNeeds description
    const index = freshIndex([
      createTextToImagePattern() as unknown as Pattern,
      createTextToSpeechPattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('voice', {}, 5)
    expect(hits.map((p) => p.id)).toContain('text-to-speech')
  })
})

describe('assetNeeds slot vocabulary is indexed (SSOT successor to capabilities prose)', () => {
  it('slot name ranks the declaring pattern', () => {
    // 'mask' exists in the assetNeeds slot name for image-to-image.
    // Without the assetNeeds ingestion block, this query must rank nothing.
    const index = freshIndex([
      createImageToImagePattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('mask', {}, 5)
    expect(hits[0]?.id).toBe('image-to-image')
  })

  it("'startFrame' slot name surfaces image-to-video (unique to assetNeeds)", () => {
    // 'startFrame' only appears in i2v assetNeeds[startFrame].slot — this
    // proves the slot-name ingestion path in isolation.
    const index = freshIndex([
      createImageToVideoPattern() as unknown as Pattern,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('startFrame', {}, 5)
    expect(hits.map((p) => p.id)).toContain('image-to-video')
  })

  it('stripping assetNeeds de-indexes startFrame (slot-name SSOT proof)', () => {
    // 'startFrame' does NOT appear in i2v tool descriptions — only in
    // assetNeeds. Stripping assetNeeds must de-rank the pattern.
    const i2vWithout = createImageToVideoPattern() as unknown as Pattern
    ;(i2vWithout as { assetNeeds?: unknown }).assetNeeds = undefined
    const index = freshIndex([
      i2vWithout,
      createTextGenerationPattern() as unknown as Pattern,
    ])
    const hits = index.search('startFrame', {}, 5)
    expect(hits.map((p) => p.id)).not.toContain('image-to-video')
  })
})
