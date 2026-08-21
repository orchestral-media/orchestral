// handleFindPattern (the `find_pattern` tool call → catalog discovery) coverage.
//
// Verifies: structured match descriptor shape (primary + outputs summary +
// assetNeeds-derived inputSchema), kind / modality / audience / router
// satisfiability filtering, K cap, includeOnly / excludeIds, query echo +
// diagnostics.
// FindPatternMatch carries no variants axis, and patterns carry no
// capabilities arrays — `inputSchema` is the LLM-facing signal for optional
// asset slots.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  deriveLlmFacingInputSchema,
  LIFT_MARKER,
  PatternRegistry,
  type Pattern,
  type CapabilityRouter,
} from '@orchestral/core'
import { handleFindPattern, PatternSearchIndex } from '@orchestral/discovery'
import {
  createAutomaticSpeechRecognitionPattern,
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createTextToImagePattern,
  createTextToSpeechPattern,
  createTextToVideoPattern,
} from '../index'

function freshIndex(patterns: readonly Pattern[]): PatternSearchIndex {
  const registry = new PatternRegistry()
  for (const p of patterns) registry.add(p as never)
  return new PatternSearchIndex(registry)
}

// Stamp the lift marker the way the host's markLiftable() does (non-enumerable
// Symbol prop). deriveLlmFacingInputSchema partitions purely on this marker, so
// a test exercising the lift must mark the field — the host stamps it via its
// own `liftable.*` builders, which these packages' tests can't import.
function mark<T extends z.ZodTypeAny>(s: T): T {
  Object.defineProperty(s, LIFT_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return s
}

// Tiny stub CapabilityRouter that returns ok=true for a configured set of
// (capability, requiredTag) pairs and ok=false for everything else.
function stubRouter(satisfiable: ReadonlyArray<{ cap: string; tag?: string }>): CapabilityRouter {
  return {
    checkSatisfiable(cap, requiredTags) {
      const tags = requiredTags ?? []
      if (tags.length === 0) {
        return satisfiable.some((s) => s.cap === cap && !s.tag)
          ? { ok: true, candidates: [] }
          : { ok: false, candidates: [], reason: { code: 'NO_MODEL_FOR_CAPABILITY' } }
      }
      for (const tag of tags) {
        if (satisfiable.some((s) => s.cap === cap && s.tag === tag)) {
          return { ok: true, candidates: [] }
        }
      }
      return { ok: false, candidates: [], reason: { code: 'NO_MODEL_FOR_TAGS', missing: [...tags] } }
    },
    // Not used by handleFindPattern.
    resolve: (() => { throw new Error('not used') }) as never,
  } as CapabilityRouter
}

describe('handleFindPattern', () => {
  describe('match descriptor shape', () => {
    it('returns primary + outputs for atomic Pattern', () => {
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      const result = handleFindPattern(index, { query: 'text to image generation' })
      const match = result.matches.find((m) => m.patternId === 'text-to-image')
      expect(match).toBeDefined()
      expect(match!.kind).toBe('atomic')
      expect(match!.namespace).toBe('image-gen')
      expect(match!.primary.toolDescription).toContain('image')
      expect(match!.primary.inputSchema).toBeDefined()
      // The variants field was removed from FindPatternMatch.
      expect((match as unknown as { variants?: unknown }).variants).toBeUndefined()
      // outputs is now a compact summary, not full JSON Schema (2026-05-28).
      // text-to-image returns image assets — both fields populated.
      expect(match!.outputs).toEqual({ modality: 'image', producesAssets: true })
      // FindPatternMatch carries no `bindings` field: host-injected bindings are
      // never rendered into the LLM-facing schema.
      expect((match as unknown as { bindings?: unknown }).bindings).toBeUndefined()
      // PatternBase.description is host-engineer prose (pattern.ts:38) — NEVER
      // surfaced to LLM. LLM gets its signal from primary.toolDescription.
      expect((match as unknown as { description?: unknown }).description).toBeUndefined()
    })

    // The LLM's signal for asset slots is the
    // assetNeeds-derived references sub-schema: typed slots, strict against
    // unknown keys. Atomics get it from AtomicPattern's ctor, metas from
    // extendInputsWithReferences at factory time; both must render it.
    it.each([
      {
        kind: 'atomic',
        patternId: 'image-to-image',
        factory: createImageToImagePattern,
        query: 'edit an image',
        slot: 'mask',
        descSnippet: 'inpaint',
      },
      {
        kind: 'meta',
        patternId: 'meta_image-to-image-via-caption',
        factory: createImageToImageViaCaptionPattern,
        query: 'approximate edit caption fallback',
        slot: 'source',
        descSnippet: 'caption round-trip',
      },
    ])(
      'primary.inputSchema contains assetNeeds-derived references with typed slots ($kind $slot)',
      ({ patternId, factory, query, slot, descSnippet }) => {
        const index = freshIndex([factory() as never as Pattern])
        const result = handleFindPattern(index, { query })
        const match = result.matches.find((m) => m.patternId === patternId)
        expect(match).toBeDefined()
        const schema = match!.primary.inputSchema as {
          properties: {
            references?: {
              properties: Record<string, unknown>
              additionalProperties?: boolean | unknown
            }
          }
        }
        expect(schema.properties.references).toBeDefined()
        const refs = schema.properties.references!
        expect(refs.properties[slot]).toBeDefined()
        // The slot description is the LLM-facing signal (inpaint UX / what to wire).
        expect(JSON.stringify(refs.properties[slot])).toContain(descSnippet)
        // strictObject → additionalProperties: false in JSON Schema
        expect(refs.additionalProperties).toBe(false)
      },
    )

    it('returns single primary descriptor for atomic Pattern', () => {
      const index = freshIndex([createImageToTextPattern() as never as Pattern])
      const result = handleFindPattern(index, { query: 'describe an image' })
      const match = result.matches.find((m) => m.patternId === 'image-to-text')
      expect(match).toBeDefined()
      expect(match!.primary.toolDescription).toContain('Read one or more images')
    })

    it('summarises outputs to {modality, producesAssets} (inline-text Pattern)', () => {
      // ASR: outputs text inline (no assets[]). Summary should reflect this.
      const index = freshIndex([
        createAutomaticSpeechRecognitionPattern() as never as Pattern,
      ])
      const result = handleFindPattern(index, { query: 'transcribe audio' })
      const match = result.matches.find(
        (m) => m.patternId === 'automatic-speech-recognition',
      )
      expect(match).toBeDefined()
      expect(match!.outputs).toEqual({ modality: 'text', producesAssets: false })
    })

    it('summarises outputs for asset-producing Pattern', () => {
      // text-to-speech: outputs assets[] (audio handles).
      const index = freshIndex([
        createTextToSpeechPattern() as never as Pattern,
      ])
      const result = handleFindPattern(index, { query: 'synthesize speech' })
      const match = result.matches.find((m) => m.patternId === 'text-to-speech')
      expect(match).toBeDefined()
      expect(match!.outputs).toEqual({ modality: 'audio', producesAssets: true })
    })

    it('handles meta Pattern (primary is the meta tool)', () => {
      const index = freshIndex([createImageToImageViaCaptionPattern() as never as Pattern])
      const result = handleFindPattern(index, { query: 'approximate edit caption fallback' })
      const match = result.matches.find((m) => m.patternId === 'meta_image-to-image-via-caption')
      expect(match).toBeDefined()
      expect(match!.kind).toBe('meta')
      expect(match!.namespace).toBe('meta-pipelines')
    })


  })

  describe('router satisfiability filter', () => {
    it('drops atomic Patterns whose modelTags no provider satisfies', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createTextToVideoPattern() as never as Pattern,
      ])
      // Router only satisfies text-to-image, NOT text-to-video.
      const router = stubRouter([{ cap: 'text-to-image' }])
      const result = handleFindPattern(index, { query: 'generate' }, { router })
      expect(result.satisfiabilityFiltered).toBe(true)
      expect(result.matches.find((m) => m.patternId === 'text-to-image')).toBeDefined()
      expect(result.matches.find((m) => m.patternId === 'text-to-video')).toBeUndefined()
    })

    it('always returns meta Patterns regardless of router (composition-time satisfiability)', () => {
      const index = freshIndex([
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      // Router unsatisfiable for everything.
      const router = stubRouter([])
      const result = handleFindPattern(
        index,
        { query: 'approximate edit caption fallback' },
        { router },
      )
      // Meta Pattern still surfaces — runtime decides at composition time.
      expect(result.matches.find((m) => m.patternId === 'meta_image-to-image-via-caption')).toBeDefined()
    })

    // The "satisfiable VARIANT (not primary) still surfaces" case was removed —
    // Variant axis deleted; isPrimarySatisfiable() now only checks the primary
    // modelTags. Atomic Patterns with empty primary modelTags (most of the
    // first-party set) still surface against any model registered under their
    // capability.
  })

  describe('kind / modality / audience filters', () => {
    it('kind=meta returns only meta matches', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const result = handleFindPattern(index, { query: 'image', kind: 'meta' })
      expect(result.matches.every((m) => m.kind === 'meta')).toBe(true)
    })

    it('modality=audio filters atomic matches to audio-gen namespace', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createAutomaticSpeechRecognitionPattern() as never as Pattern,
      ])
      const result = handleFindPattern(index, { query: 'create', modality: 'audio' })
      expect(result.matches.every((m) => m.namespace === 'audio-gen')).toBe(true)
    })

    it("audience='chat-turn' hides Patterns with exposure='agent-tool'", () => {
      const agentToolPattern = createTextToImagePattern() as Pattern & {
        exposure?: string
      }
      // Mutate exposure for the test. Pattern factories don't expose this knob
      // today; in production a Pattern author would set it in the factory call.
      Object.assign(agentToolPattern, { exposure: 'agent-tool' })
      const index = freshIndex([agentToolPattern])
      const chatTurn = handleFindPattern(index, { query: 'image' }, { audience: 'chat-turn' })
      const agentLoop = handleFindPattern(index, { query: 'image' }, { audience: 'agent-loop' })
      expect(chatTurn.matches.find((m) => m.patternId === 'text-to-image')).toBeUndefined()
      expect(agentLoop.matches.find((m) => m.patternId === 'text-to-image')).toBeDefined()
    })

    it("exposure='no-tool' hides Pattern from all audiences", () => {
      const hiddenPattern = createTextToImagePattern() as Pattern & { exposure?: string }
      Object.assign(hiddenPattern, { exposure: 'no-tool' })
      const index = freshIndex([hiddenPattern])
      const chatTurn = handleFindPattern(index, { query: 'image' }, { audience: 'chat-turn' })
      const agentLoop = handleFindPattern(index, { query: 'image' }, { audience: 'agent-loop' })
      expect(chatTurn.matches.length).toBe(0)
      expect(agentLoop.matches.length).toBe(0)
    })
  })

  describe('includeOnly / excludeIds', () => {
    it('includeOnly scopes search to allowlist', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
      ])
      const result = handleFindPattern(
        index,
        { query: 'image' },
        { includeOnly: new Set(['text-to-image']) },
      )
      expect(result.matches.map((m) => m.patternId)).toEqual(['text-to-image'])
    })

    it('excludeIds drops matches', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
      ])
      const result = handleFindPattern(
        index,
        { query: 'image' },
        { excludeIds: new Set(['text-to-image']) },
      )
      expect(result.matches.find((m) => m.patternId === 'text-to-image')).toBeUndefined()
    })
  })

  describe('K cap + diagnostics', () => {
    it('returns at most k matches', () => {
      const index = freshIndex([
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
        createImageToTextPattern() as never as Pattern,
        createTextToVideoPattern() as never as Pattern,
      ])
      const result = handleFindPattern(index, { query: 'something' }, { k: 2 })
      expect(result.matches.length).toBeLessThanOrEqual(2)
    })

    it('echoes query + filters in result', () => {
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      const result = handleFindPattern(index, {
        query: 'foo',
        kind: 'atomic',
        modality: 'image',
      })
      expect(result.query).toBe('foo')
      expect(result.filtersApplied.kind).toBe('atomic')
      expect(result.filtersApplied.modality).toBe('image')
    })

    it('omits diagnostic when matches is non-empty', () => {
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      const result = handleFindPattern(index, { query: 'image' })
      expect(result.matches.length).toBeGreaterThan(0)
      expect(result.diagnostic).toBeUndefined()
    })

    it('returns diagnostic with exposure drop count when all matches hidden', () => {
      // Two patterns matching the query but both `exposure='no-tool'` —
      // hides them from every audience; matches should be [] with a
      // diagnostic explaining `2 hidden from this audience`.
      const hidden1 = Object.assign(createTextToImagePattern(), {
        exposure: 'no-tool' as const,
      })
      const hidden2 = Object.assign(createImageToImagePattern(), {
        exposure: 'no-tool' as const,
      })
      const index = freshIndex([hidden1 as never as Pattern, hidden2 as never as Pattern])
      const result = handleFindPattern(index, { query: 'image' })
      expect(result.matches.length).toBe(0)
      expect(result.diagnostic).toBeDefined()
      expect(result.diagnostic!.droppedBy.exposure).toBe(2)
      expect(result.diagnostic!.droppedBy.satisfiability).toBe(0)
      expect(result.diagnostic!.droppedBy.hostOnly).toBe(0)
      expect(result.diagnostic!.suggestion).toContain('exposure filter')
    })

    it('returns diagnostic with satisfiability drop count when all variants unsatisfiable', () => {
      const index = freshIndex([createTextToVideoPattern() as never as Pattern])
      // Router satisfies nothing.
      const router = stubRouter([])
      const result = handleFindPattern(index, { query: 'video' }, { router })
      expect(result.matches.length).toBe(0)
      expect(result.diagnostic).toBeDefined()
      expect(result.diagnostic!.droppedBy.satisfiability).toBeGreaterThan(0)
      expect(result.diagnostic!.suggestion).toContain('no model')
    })

    it('returns diagnostic with empty raw-set message when corpus is empty', () => {
      // Empty registry → BM25 has nothing to score → raw = [] → matches = [].
      // (Trying to force raw=[] on a populated corpus is brittle because
      // minisearch's `fuzzy + prefix` defaults match almost any token.)
      const index = freshIndex([])
      const result = handleFindPattern(index, { query: 'anything' })
      expect(result.matches.length).toBe(0)
      expect(result.totalCandidates).toBe(0)
      expect(result.diagnostic).toBeDefined()
      expect(result.diagnostic!.suggestion).toContain('broader')
    })

    it('skips host-only agent Pattern (kind=agent without primary tool)', () => {
      const hostOnlyAgent: Pattern = {
        id: 'agent_host_only_indexed',
        kind: 'agent',
        description: 'host-only agent referenced in index',
        // No outputs/finish declared — the agent never returns structured
        // outputs (test exercises the host-only branch), so the registry
        // backfills the default finish envelope at registration.
        loop: { toolPatternIds: [] },
        // primary intentionally absent
      } as never
      const registry = new PatternRegistry()
      registry.register(hostOnlyAgent as never)
      const index = new PatternSearchIndex(registry)
      const result = handleFindPattern(index, { query: 'agent host-only' })
      // The host-only agent has no LLM-callable schema — surfacing it would
      // waste a round-trip (LLM would dispatch and get AGENT_HOST_ONLY back).
      expect(
        result.matches.find((m) => m.patternId === 'agent_host_only_indexed'),
      ).toBeUndefined()
      // And the drop is accounted for in the diagnostic.
      expect(result.diagnostic).toBeDefined()
      expect(result.diagnostic!.droppedBy.hostOnly).toBeGreaterThanOrEqual(1)
    })
  })

  // ── derive integration ──────────────────────────────────────────────────
  describe('providerOptions-driven schema lift', () => {
    it('lifts top-candidate providerOptions into primary.inputSchema (Suno literal)', async () => {
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      // Suno-like provider: forces n=2. `n` carries the lift marker (the host's
      // liftable.n() builder stamps it), so the merge lifts it to top level.
      const sunoOpts = z.object({
        n: mark(z.literal(2)),
        lyrics: z.string().optional(),
      })
      // The closure returns the MERGED LLM-facing schema (the
      // host invokes the lift), and find_pattern just z2js-es it.
      const result = handleFindPattern(
        index,
        { query: 'text to image' },
        {
          deriveProviderOptionsZod: (patternId, baseSchema) => {
            if (patternId === 'text-to-image') {
              return deriveLlmFacingInputSchema(baseSchema, sunoOpts)
            }
            return undefined
          },
        },
      )
      const match = result.matches.find((m) => m.patternId === 'text-to-image')
      expect(match).toBeDefined()
      const schema = match!.primary.inputSchema as {
        properties: { n: { const?: number; type?: string } }
      }
      // The lifted `n` should be a const(2) literal — LLM cannot fill n=3.
      expect(schema.properties.n).toBeDefined()
      expect(schema.properties.n.const).toBe(2)
    })

    it('surfaces atomic with base inputSchema when callback returns undefined (degraded fallback, no drop)', () => {
      // Invariant: providerOptions is per-model progressive enhancement, not
      // a capability-visibility gate. When derive returns undefined the
      // atomic still appears in matches with the base inputSchema (no
      // providerOptions lift). LLM invokes with prompt + base fields; model
      // uses its default providerOptions at dispatch.
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      const result = handleFindPattern(
        index,
        { query: 'text to image' },
        {
          deriveProviderOptionsZod: () => undefined,
        },
      )
      const match = result.matches.find((m) => m.patternId === 'text-to-image')
      expect(match).toBeDefined()
      const schema = match!.primary.inputSchema as {
        properties: Record<string, { type?: string; properties?: unknown; additionalProperties?: unknown }>
      }
      expect(schema.properties.prompt).toBeDefined()
      // The Pattern factory no longer declares a `providerOptions`
      // placeholder. When derive returns undefined, deriveLlmFacingInputSchema
      // returns baseSchema unchanged — which means `providerOptions` is
      // absent entirely (not a degraded `z.record(z.unknown())`). LLM doesn't
      // see a useless empty record; it can still fill the rest of the input.
      expect(schema.properties.providerOptions).toBeUndefined()
    })

    it('passes slim base Pattern through when callback NOT provided (no degraded mode)', () => {
      // When the caller doesn't pass deriveProviderOptionsZod at all, the
      // library doesn't try to determine if a schema is curated — falls back to
      // serving the static Pattern.input schema as-is. This preserves the
      // "works standalone without a host catalog" mode (e.g. unit tests,
      // CLI tools that don't need provider-aware lift).
      const index = freshIndex([createTextToImagePattern() as never as Pattern])
      const result = handleFindPattern(
        index,
        { query: 'text to image' },
        // intentionally no deriveProviderOptionsZod
      )
      const match = result.matches.find((m) => m.patternId === 'text-to-image')
      expect(match).toBeDefined()
      const schema = match!.primary.inputSchema as {
        properties: Record<string, unknown>
      }
      // The static base is exactly { prompt, references }.
      // Without a host closure, no ai-sdk param (n / size / …) is lifted, so the
      // standalone schema shows only the two base fields.
      expect(Object.keys(schema.properties).sort()).toEqual(['prompt', 'references'])
      expect(schema.properties.n).toBeUndefined()
      expect(schema.properties.size).toBeUndefined()
    })

    it('does not lift on meta Patterns (no provider resolved at find time)', async () => {
      const index = freshIndex([
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const opts = z.object({ n: mark(z.literal(2)) })
      const result = handleFindPattern(
        index,
        { query: 'approximate edit caption fallback' },
        {
          // find_pattern only invokes the closure for atomic Patterns, so for a
          // meta this never runs — proving meta takes its base tool inputs
          // regardless of what the closure would lift.
          deriveProviderOptionsZod: (_id, baseSchema) =>
            deriveLlmFacingInputSchema(baseSchema, opts),
        },
      )
      const match = result.matches.find(
        (m) => m.patternId === 'meta_image-to-image-via-caption',
      )
      expect(match).toBeDefined()
      // Meta primary input is the meta tool inputs (editPrompt / tier /
      // providerOptions) — not the t2i lifted schema.
      const schema = match!.primary.inputSchema as {
        properties: Record<string, unknown>
      }
      expect(schema.properties).toHaveProperty('editPrompt')
      expect(schema.properties).toHaveProperty('tier')
      // Meta doesn't lift n — n is not in the meta input shape.
      expect(schema.properties.n).toBeUndefined()
    })
  })
})
