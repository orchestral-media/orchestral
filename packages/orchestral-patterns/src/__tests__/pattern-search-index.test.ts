// PatternSearchIndex (the BM25 retrieval backend behind find_pattern) coverage.
//
// We exercise: BM25 ranking signal, kind / modality / includeOnly / excludeIds
// filters, top-K cap, mid-life add / remove, empty-query short-circuit,
// rebuild after registry mutation, CJK tokenization, patternIdParts boosting,
// select: direct-id syntax, +term mandatory-keyword syntax.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  silentDiagnosticsLogger,
  defineAtomicPattern,
  PatternRegistry,
  type ZodSchema,
  type Pattern,
} from '@orchestral/core'
import { PatternSearchIndex } from '@orchestral/discovery'
import {
  createTextToImagePattern,
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createTextToVideoPattern,
  createTextToSpeechPattern,
  createAutomaticSpeechRecognitionPattern,
  createTextGenerationPattern,
} from '../index'

function freshRegistry(patterns: readonly Pattern[]): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) {
    // PatternRegistry.add expands variants/alternatives into getEntry attachments.
    // factories return PatternBase subclasses that satisfy it.
    registry.add(p as never)
  }
  return registry
}

/**
 * Lightweight test-only pattern factory. We need direct control over `id` and
 * `description` to exercise CJK tokenization and patternIdParts boosting
 * without depending on the first-party catalog's prose changing under us.
 */
function makeTestPattern(opts: {
  id: string
  description: string
  primaryDescription?: string
  searchHint?: string
  namespace?: 'image-gen' | 'video-gen' | 'audio-gen' | 'text-gen'
}): Pattern {
  const schema = z.object({}) as unknown as ZodSchema<unknown>
  const outputs = z.object({
    modality: z.literal('text'),
  }) as unknown as ZodSchema<unknown>
  return defineAtomicPattern({
    id: opts.id,
    namespace: opts.namespace ?? 'image-gen',
    description: opts.description,
    searchHint: opts.searchHint,
    primary: {
      tool: {
        description: opts.primaryDescription ?? opts.description,
        inputs: schema,
      },
      modelTags: [],
    },
    outputs,
  }) as unknown as Pattern
}

describe('PatternSearchIndex', () => {
  describe('basic ranking', () => {
    it('finds text-to-image when user asks to generate an image', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createTextGenerationPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('generate an image from text', {}, 5)
      expect(hits.map((p) => p.id)).toContain('text-to-image')
      // image-to-image should also be high signal but text-to-image is the
      // primary match because BM25 weights the "from text" + "generate" verbs.
    })

    it('finds image-to-image when user asks to edit an image', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToTextPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('edit an existing image with a prompt', {}, 5)
      expect(hits[0]?.id).toBe('image-to-image')
    })

    it('finds asr when user asks to transcribe speech', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createAutomaticSpeechRecognitionPattern() as never as Pattern,
        createTextToSpeechPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('transcribe spoken audio to text', {}, 5)
      expect(hits[0]?.id).toBe('automatic-speech-recognition')
    })
  })

  describe('kind filter', () => {
    it('returns only atomic Patterns when kind=atomic', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image', { kind: 'atomic' }, 5)
      expect(hits.every((p) => p.kind === 'atomic')).toBe(true)
      expect(hits.find((p) => p.id === 'meta_image-to-image-via-caption')).toBeUndefined()
    })

    it('returns only meta Patterns when kind=meta', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image', { kind: 'meta' }, 5)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((p) => p.kind === 'meta')).toBe(true)
    })
  })

  describe('modality filter', () => {
    it('atomic + modality=image returns only image-gen Patterns', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createTextToVideoPattern() as never as Pattern,
        createAutomaticSpeechRecognitionPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('create something', { modality: 'image' }, 5)
      expect(hits.every((p) => p.namespace === 'image-gen')).toBe(true)
    })

    it('modality filter is ignored for non-atomic Patterns', () => {
      // via-caption has kind=meta, namespace=meta-pipelines; modality filter
      // shouldn't drop it because modality only constrains atomic. Test by
      // confirming the same query returns the meta Pattern both with and
      // without the filter — the filter is a no-op for non-atomic kinds.
      const registry = freshRegistry([
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const noFilter = index.search('approximate edit caption fallback', {}, 5)
      const withModalityFilter = index.search(
        'approximate edit caption fallback',
        { modality: 'image' },
        5,
      )
      // Both queries should produce identical results for non-atomic Patterns.
      expect(withModalityFilter.map((p) => p.id)).toEqual(noFilter.map((p) => p.id))
      // And the meta pattern survives the modality filter (the filter is no-op).
      if (noFilter.length > 0) {
        expect(withModalityFilter.find((p) => p.id === 'meta_image-to-image-via-caption')).toBeDefined()
      }
    })
  })

  describe('includeOnly + excludeIds', () => {
    it('includeOnly restricts the search corpus', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToTextPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image', { includeOnly: new Set(['image-to-image']) }, 5)
      expect(hits.map((p) => p.id)).toEqual(['image-to-image'])
    })

    it('excludeIds drops matches', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image', { excludeIds: new Set(['text-to-image']) }, 5)
      expect(hits.find((p) => p.id === 'text-to-image')).toBeUndefined()
    })
  })

  describe('top-K cap', () => {
    it('returns at most k results', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToTextPattern() as never as Pattern,
        createTextToVideoPattern() as never as Pattern,
        createTextToSpeechPattern() as never as Pattern,
        createAutomaticSpeechRecognitionPattern() as never as Pattern,
        createTextGenerationPattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('something', {}, 3)
      expect(hits.length).toBeLessThanOrEqual(3)
    })
  })

  describe('empty query short-circuit', () => {
    it('returns no matches for empty / whitespace query', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      expect(index.search('', {}, 5)).toEqual([])
      expect(index.search('   \t  ', {}, 5)).toEqual([])
    })
  })

  describe('mutation', () => {
    it('add / remove sync the index', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      expect(index.size).toBe(1)

      const newPattern = createImageToImagePattern() as never as Pattern
      index.add(newPattern)
      expect(index.size).toBe(2)
      expect(index.search('edit image', {}, 5).find((p) => p.id === 'image-to-image')).toBeDefined()

      index.remove('image-to-image')
      expect(index.size).toBe(1)
      expect(index.search('edit image', {}, 5).find((p) => p.id === 'image-to-image')).toBeUndefined()
    })

    it('rebuild resyncs from registry', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      // Add to registry without touching index
      registry.register(createImageToImagePattern() as never)
      // Index hasn't seen the new Pattern yet
      expect(index.size).toBe(1)
      // Rebuild syncs
      index.rebuild(registry)
      expect(index.size).toBe(2)
    })
  })

  describe('CJK-aware tokenization', () => {
    it('matches English query against English description (default behavior preserved)', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-en',
          description: 'find and search images in the gallery',
        }),
        makeTestPattern({
          id: 'pat-noise',
          description: 'unrelated audio transcription tool',
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('search', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-en')
    })

    it('matches CJK query via 2-gram against CJK description', () => {
      // "查找图片" = "find images" — both pattern and query are CJK so neither
      // touches the English fast path. The 2-gram tokenizer turns "查找图片"
      // into ["查找","找图","图片","查","找","图","片"]; the description's
      // "图片" produces a token of "图片", so the query "图片" must hit.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-cjk',
          description: '查找图片并显示在画廊里',
        }),
        makeTestPattern({
          id: 'pat-noise',
          description: 'unrelated audio transcription tool',
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('图片', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-cjk')
    })

    it('single-character CJK query hits via 1-gram fallback', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-cjk-short',
          description: '图',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('图', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-cjk-short')
    })

    it('mixed English+CJK query splits correctly', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-mixed',
          description: 'image editor 编辑图片 with prompt',
        }),
        makeTestPattern({
          id: 'pat-en-only',
          description: 'unrelated text generation',
          namespace: 'text-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // "编辑" should match via 2-gram even though it's embedded mid-token
      // alongside English.
      const hits = index.search('编辑', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-mixed')
      // English half also still works.
      const enHits = index.search('image editor', {}, 5)
      expect(enHits.map((p) => p.id)).toContain('pat-mixed')
    })
  })

  describe('patternIdParts boost', () => {
    it('"image text" query surfaces image-to-text via id tokens', () => {
      // pattern descriptions are intentionally identical so the only
      // distinguishing signal is the pattern id — exercises that id tokens
      // are actually being indexed + boosted.
      const generic = 'A neutral description with no distinguishing terms.'
      const registry = freshRegistry([
        makeTestPattern({
          id: 'image-to-text',
          description: generic,
          namespace: 'text-gen',
        }),
        makeTestPattern({
          id: 'audio-to-speech',
          description: generic,
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image text', {}, 5)
      expect(hits[0]?.id).toBe('image-to-text')
    })

    it('stopword-only query against patternIdParts returns no boost match', () => {
      // 'to' is a stopword — should be filtered out of patternIdParts so
      // `image-to-text` doesn't dominate the result list for a query of
      // just "to". The description provides no signal either.
      const generic = 'Neutral description.'
      const registry = freshRegistry([
        makeTestPattern({
          id: 'image-to-text',
          description: generic,
          namespace: 'text-gen',
        }),
        makeTestPattern({
          id: 'audio-only',
          description: generic,
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('to', {}, 5)
      // 'to' is a stopword so it shouldn't single-handedly surface
      // image-to-text via the id-parts boost.
      expect(hits.find((p) => p.id === 'image-to-text')).toBeUndefined()
    })

    it('stopwords in tool descriptions do not score query hits', () => {
      // 'to' appears in brief2video's description but is pure function-word
      // noise — it must not make brief2video a hit for a query whose only
      // overlap is that stopword. (patternIdParts already strips stopwords;
      // this exercises the description field + the query side.)
      const registry = freshRegistry([
        makeTestPattern({
          id: 'brief2video',
          description: 'brief to multi-scene video',
          namespace: 'video-gen',
        }),
        makeTestPattern({
          id: 'image-edit',
          description: 'edit an existing image',
          namespace: 'image-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('image to image inpainting mask', {}, 5)
      expect(hits.find((p) => p.id === 'brief2video')).toBeUndefined()
    })

    it('underscore-separated ids tokenize the same as hyphen-separated', () => {
      const generic = 'Neutral description.'
      const registry = freshRegistry([
        makeTestPattern({
          id: 'compose_with_track',
          description: generic,
          namespace: 'audio-gen',
        }),
        makeTestPattern({
          id: 'noise-only',
          description: generic,
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // 'with' is a stopword so the meaningful tokens are "compose" + "track".
      const hits = index.search('compose track', {}, 5)
      expect(hits[0]?.id).toBe('compose_with_track')
    })
  })

  describe('searchHint boost', () => {
    it('matches when description is neutral but searchHint contains the keyword', () => {
      const generic = 'A neutral description with no distinguishing terms.'
      const registry = freshRegistry([
        makeTestPattern({
          id: 'mystery-a',
          description: generic,
          searchHint: 'caption describe ocr vision understand',
          namespace: 'text-gen',
        }),
        makeTestPattern({
          id: 'mystery-b',
          description: generic,
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('caption', {}, 5)
      expect(hits[0]?.id).toBe('mystery-a')
    })

    it('searchHint is optional — undefined hint does not break indexing', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'no-hint',
          description: 'unique describable visualization tool',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('visualization', {}, 5)
      expect(hits[0]?.id).toBe('no-hint')
    })

    it('+term mandatory check also reads searchHint', () => {
      const generic = 'Neutral description.'
      const registry = freshRegistry([
        makeTestPattern({
          id: 'has-hint',
          description: generic,
          searchHint: 'image caption describe',
        }),
        makeTestPattern({
          id: 'plain',
          description: generic,
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+caption describe', {}, 5)
      expect(hits.map((p) => p.id)).toContain('has-hint')
      expect(hits.find((p) => p.id === 'plain')).toBeUndefined()
    })
  })

  // NOTE: `select:<id>` direct-id selection is NOT a PatternSearchIndex.search()
  // concern — it is intercepted upstream by find_pattern's `parseSelector`, which
  // resolves ids straight off the registry and feeds them through `applyFilter`.
  // Its behaviour is covered by @orchestral/core's find-pattern.test.ts. search()
  // only ever sees free-form BM25 / +term queries.

  describe('+term mandatory-keyword syntax', () => {
    it('drops patterns whose searchable text lacks the +term', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'image-tool',
          description: 'edit and manipulate images',
        }),
        makeTestPattern({
          id: 'audio-tool',
          description: 'edit and manipulate audio tracks',
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // Without +image, edit alone would surface both patterns.
      const hits = index.search('+image edit', {}, 5)
      expect(hits.map((p) => p.id)).toContain('image-tool')
      expect(hits.find((p) => p.id === 'audio-tool')).toBeUndefined()
    })

    it('uses word-boundary semantics — "+image" does not match "imagery"', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'imagery-only',
          description: 'imagery analysis and tagging',
        }),
        makeTestPattern({
          id: 'true-image',
          description: 'image manipulation and analysis',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+image analysis', {}, 5)
      // imagery-only should be filtered out — 'image' has no word boundary in
      // 'imagery'. true-image should remain because its description has
      // standalone "image".
      expect(hits.find((p) => p.id === 'imagery-only')).toBeUndefined()
      expect(hits.find((p) => p.id === 'true-image')).toBeDefined()
    })

    it('multiple +terms all required (AND semantics)', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'both',
          description: 'image and audio multimodal processing',
        }),
        makeTestPattern({
          id: 'image-only',
          description: 'image processing pipeline',
        }),
        makeTestPattern({
          id: 'audio-only',
          description: 'audio processing pipeline',
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+image +audio processing', {}, 5)
      expect(hits.map((p) => p.id)).toContain('both')
      expect(hits.find((p) => p.id === 'image-only')).toBeUndefined()
      expect(hits.find((p) => p.id === 'audio-only')).toBeUndefined()
    })

    it('+term also checks patternIdParts (id-only signal)', () => {
      // description has nothing about "image", but the id does — so +image
      // must still survive against the id tokens.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'image-generator',
          description: 'create new pictures from prompts',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+image pictures', {}, 5)
      expect(hits.map((p) => p.id)).toContain('image-generator')
    })

    it('CJK +term uses substring match against the haystack', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-with-cjk',
          description: '图片 editing tool',
        }),
        makeTestPattern({
          id: 'pat-en-only',
          description: 'unrelated editor',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+图片 editing', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-with-cjk')
      expect(hits.find((p) => p.id === 'pat-en-only')).toBeUndefined()
    })

    it('bare +term with no optional terms still BM25-ranks', () => {
      // requiredTerms.length > 0 && optionalTerms.length === 0 path —
      // bm25Query falls back to the de-prefixed required terms.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'image-tool',
          description: 'edit images',
        }),
        makeTestPattern({
          id: 'audio-tool',
          description: 'edit audio',
          namespace: 'audio-gen',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      const hits = index.search('+image', {}, 5)
      expect(hits.map((p) => p.id)).toContain('image-tool')
      expect(hits.find((p) => p.id === 'audio-tool')).toBeUndefined()
    })

    it('+term escapes regex metacharacters (no false-positive match)', () => {
      // A +term containing regex specials (e.g. '.') must match the literal
      // sequence, not be interpreted as a regex wildcard.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-versioned',
          description: 'model.v2 release notes',
        }),
        makeTestPattern({
          id: 'pat-other',
          description: 'modelXv2 different artifact',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // '+model.v2' must only match the literal 'model.v2'. If '.' were not
      // escaped it would also match 'modelXv2' (any char between l and v).
      const hits = index.search('+model.v2 release', {}, 5)
      expect(hits.map((p) => p.id)).toContain('pat-versioned')
      expect(hits.find((p) => p.id === 'pat-other')).toBeUndefined()
    })
  })

  describe('PatternBase.description excluded from BM25', () => {
    // Critical invariant of the B+b3 refactor: PatternBase.description is
    // host-engineer prose, not LLM-facing — it must NOT participate in BM25.
    // makeTestPattern's primaryDescription default mirrors description into
    // primary.tool.description (and thus into the toolDescriptions field),
    // so to isolate this invariant we pass disjoint primaryDescription.

    it('description-only tokens do not surface in BM25 ranking', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-prose',
          description: 'ZZZ_HOST_ONLY_TOKEN gallery',
          primaryDescription: 'neutral tool prose',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // 'ZZZ_HOST_ONLY_TOKEN' only lives in PatternBase.description; if BM25
      // still indexed that field, this would surface. With B+b3 it must not.
      expect(index.search('ZZZ_HOST_ONLY_TOKEN', {}, 5)).toEqual([])
    })

    it('+term mandatory check also excludes description', () => {
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-prose',
          description: 'UNIQUE_HOST_KEYWORD inside host prose',
          primaryDescription: 'shared',
        }),
      ])
      const index = new PatternSearchIndex(registry)
      // '+UNIQUE_HOST_KEYWORD' lives only in PatternBase.description; the
      // haystack must not include description, so this must filter out.
      expect(index.search('+UNIQUE_HOST_KEYWORD shared', {}, 5)).toEqual([])
    })
  })

  describe('robustness — fall-through tokenization', () => {
    it('CJK Extension B (4-byte) characters do not throw during indexing', () => {
      // U+20000+ codepoints fall outside isCjkChar's [U+4E00-U+9FFF +
      // U+3400-U+4DBF] range. Pin current behavior: index tolerates them
      // (falls through to default tokenizer), no throw.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-ext-b',
          description: '\u{20000} archaic glyph',
          primaryDescription: '\u{20000} archaic glyph',
        }),
      ])
      expect(() => new PatternSearchIndex(registry)).not.toThrow()
    })

    it('Hiragana / Katakana fall back to default tokenizer (no n-gram explosion)', () => {
      // pattern-search-index.ts:isCjkChar deliberately excludes hiragana /
      // katakana. Pin current behavior: indexing tolerates them, default
      // whitespace+punctuation split applies.
      const registry = freshRegistry([
        makeTestPattern({
          id: 'pat-jp',
          description: 'こんにちは test',
          primaryDescription: 'こんにちは test',
        }),
      ])
      expect(() => new PatternSearchIndex(registry)).not.toThrow()
      const index = new PatternSearchIndex(registry)
      // English half still works.
      expect(index.search('test', {}, 5).find((p) => p.id === 'pat-jp')).toBeDefined()
    })

    it('all-stopword pattern id (empty patternIdParts) does not crash indexing', () => {
      // tokenizePatternId('to-and-from') filters all 3 tokens → ''. Verify
      // indexing tolerates empty patternIdParts (minisearch allows missing /
      // empty field values per doc).
      const registry = freshRegistry([
        makeTestPattern({
          id: 'to-and-from',
          description: 'an unusual edge-case pattern',
          primaryDescription: 'an unusual edge-case pattern',
        }),
      ])
      expect(() => new PatternSearchIndex(registry)).not.toThrow()
      const index = new PatternSearchIndex(registry)
      expect(index.size).toBe(1)
    })
  })

  describe('skipped tracking', () => {
    it('exposes empty skipped[] under normal operation', () => {
      const registry = freshRegistry([
        createTextToImagePattern() as never as Pattern,
      ])
      const index = new PatternSearchIndex(registry)
      expect(index.skipped).toEqual([])
    })
  })
})
