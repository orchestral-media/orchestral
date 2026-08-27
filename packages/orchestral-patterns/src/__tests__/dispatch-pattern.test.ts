// resolveDispatchTarget (the `dispatch_pattern` tool call → Pattern) coverage.
//
// Verifies: pattern lookup error / variant lookup error / agent-host-only
// error / exposure scope enforcement / zod input validation failure carries
// structured issues / success path returns target + parsed input / variant
// input intersection logic.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  silentDiagnosticsLogger,
  isDispatchError,
  resolveDispatchTarget,
  PatternRegistry,
  type Pattern,
} from '@orchestral/core'
import {
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createTextGenerationPattern,
  createTextToImagePattern,
} from '../index'

function freshRegistry(patterns: readonly Pattern[]): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p as never)
  return registry
}

describe('resolveDispatchTarget', () => {
  describe('error paths', () => {
    it('returns PATTERN_NOT_FOUND when pattern_id is unknown', () => {
      const registry = freshRegistry([createTextToImagePattern() as never as Pattern])
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'no-such-pattern', input: { prompt: 'hi' } },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(true)
      if (isDispatchError(result) && result.code === 'PATTERN_NOT_FOUND') {
        expect(result.pattern_id).toBe('no-such-pattern')
        expect(result.hint).toContain('find_pattern')
      } else {
        throw new Error('expected PATTERN_NOT_FOUND')
      }
    })

    // VARIANT_NOT_FOUND tests removed — variant axis deleted,
    // `variant_id` is no longer a field on DispatchPatternInputSchema,
    // and `VARIANT_NOT_FOUND` is no longer in DispatchPatternError.

    // nested strictObject survives top-level passthrough: undeclared slot
    // keys must fail identically for atomics (ctor injection) and metas
    // (factory injection via extendInputsWithReferences).
    it.each([
      {
        kind: 'atomic',
        patternId: 'image-to-image',
        factory: createImageToImagePattern,
        input: { prompt: 'make it neon', references: { bad_slot: 'image_1' } },
      },
      {
        kind: 'meta',
        patternId: 'meta_image-to-image-via-caption',
        factory: createImageToImageViaCaptionPattern,
        input: { editPrompt: 'make it neon', references: { bad_slot: 'image_1' } },
      },
    ])(
      'returns INPUT_VALIDATION_FAILED for an undeclared references slot key ($kind)',
      ({ patternId, factory, input }) => {
        const registry = freshRegistry([factory() as never as Pattern])
        const result = resolveDispatchTarget(
          registry,
          { pattern_id: patternId, input },
          'chat-turn',
        )
        expect(isDispatchError(result)).toBe(true)
        if (isDispatchError(result) && result.code === 'INPUT_VALIDATION_FAILED') {
          expect(result.issues.length).toBeGreaterThan(0)
          const slotIssue = result.issues.find((i: z.core.$ZodIssue) =>
            i.path.includes('references'),
          )
          expect(slotIssue).toBeDefined()
          // The hint must name the offending key AND the pattern's declared
          // reference slots so the model self-corrects instead of guessing
          // synonyms (mirrors HANDLE_NOT_FOUND's meta.available). Assert on the
          // bad key + `source` (declared by both fixtures) + the structural
          // marker — independent of whether styleRef / mask exist on a given one.
          expect(result.hint).toContain('bad_slot')
          expect(result.hint).toContain('source')
          expect(result.hint).toContain('references.{')
        } else {
          throw new Error('expected INPUT_VALIDATION_FAILED for undeclared references.bad_slot')
        }
      },
    )

    it('returns INPUT_VALIDATION_FAILED with zod issues', () => {
      const registry = freshRegistry([createTextToImagePattern() as never as Pattern])
      const result = resolveDispatchTarget(
        registry,
        {
          pattern_id: 'text-to-image',
          // missing required `prompt` — an unknown extra key (post-slim `size`
          // is no longer a base field) must not satisfy the required prompt.
          input: { size: '1024x1024' },
        },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(true)
      if (isDispatchError(result) && result.code === 'INPUT_VALIDATION_FAILED') {
        expect(result.issues.length).toBeGreaterThan(0)
        const promptIssue = result.issues.find((i: z.core.$ZodIssue) =>
          i.path.includes('prompt'),
        )
        expect(promptIssue).toBeDefined()
      } else {
        throw new Error('expected INPUT_VALIDATION_FAILED')
      }
    })

    // Not covered: the try/catch around schema.safeParse in
    // resolveDispatchTarget. Exercising it needs a zod-version-specific
    // fixture that makes safeParse() actually throw — zod v4's safeParse is
    // contractually never-throw, so that catch is purely defensive.

    it("returns AGENT_HOST_ONLY when agent Pattern has no primary tool (host-only)", () => {
      // Construct an agent-like Pattern without a primary tool. Today's
      // first-party Pattern factories all have primary, so we mock the
      // host-only edge case directly via Object.assign on a known agent
      // shape (handled by Pattern.kind dispatch in resolveDispatchTarget).
      const hostOnlyAgent: Pattern = {
        id: 'agent_host_only_test',
        kind: 'agent',
        description: 'host-only',
        // No outputs/finish declared — host-only agents don't expose outputs
        // to LLMs, so the registry backfills the default finish envelope.
        loop: { toolPatternIds: [] },
        // primary intentionally absent
      } as never
      const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
      registry.register(hostOnlyAgent as never)
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'agent_host_only_test', input: {} },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(true)
      if (isDispatchError(result)) {
        expect(result.code).toBe('AGENT_HOST_ONLY')
      }
    })

    it("rejects exposure='no-tool' Pattern under any audience (PATTERN_NOT_DISPATCHABLE)", () => {
      const hostOnly = Object.assign(createTextToImagePattern(), {
        exposure: 'no-tool' as const,
      })
      const registry = freshRegistry([hostOnly as never as Pattern])
      for (const audience of ['chat-turn', 'agent-loop'] as const) {
        const result = resolveDispatchTarget(
          registry,
          { pattern_id: 'text-to-image', input: { prompt: 'hi' } },
          audience,
        )
        expect(isDispatchError(result)).toBe(true)
        if (
          isDispatchError(result) &&
          result.code === 'PATTERN_NOT_DISPATCHABLE'
        ) {
          expect(result.exposure).toBe('no-tool')
          expect(result.audience).toBe(audience)
          expect(result.hint).toContain('find_pattern')
        } else {
          throw new Error(`expected PATTERN_NOT_DISPATCHABLE for audience=${audience}`)
        }
      }
    })

    it("rejects exposure='agent-tool' Pattern under chat-turn audience", () => {
      const agentTool = Object.assign(createTextToImagePattern(), {
        exposure: 'agent-tool' as const,
      })
      const registry = freshRegistry([agentTool as never as Pattern])
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'text-to-image', input: { prompt: 'hi' } },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(true)
      if (
        isDispatchError(result) &&
        result.code === 'PATTERN_NOT_DISPATCHABLE'
      ) {
        expect(result.exposure).toBe('agent-tool')
        expect(result.audience).toBe('chat-turn')
      } else {
        throw new Error('expected PATTERN_NOT_DISPATCHABLE under chat-turn')
      }
    })

    it("permits exposure='agent-tool' Pattern under agent-loop audience", () => {
      const agentTool = Object.assign(createTextToImagePattern(), {
        exposure: 'agent-tool' as const,
      })
      const registry = freshRegistry([agentTool as never as Pattern])
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'text-to-image', input: { prompt: 'hi' } },
        'agent-loop',
      )
      expect(isDispatchError(result)).toBe(false)
    })
  })

  describe('success paths', () => {
    it('resolves primary path with parsed input', () => {
      const registry = freshRegistry([createTextToImagePattern() as never as Pattern])
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'text-to-image', input: { prompt: 'a sunset' } },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(false)
      if (!isDispatchError(result)) {
        expect(result.pattern.id).toBe('text-to-image')
        expect(result.parsedInput.prompt).toBe('a sunset')
        // Base is exactly { prompt, references } — the ai-sdk params
        // (n / size / aspectRatio / seed) are not base fields, so
        // they don't appear (and don't get a default) on the standalone parse.
        // They arrive only via the per-model liftable lift in a hosted catalog.
        const keys = Object.keys(result.parsedInput as Record<string, unknown>)
        expect(keys).toEqual(['prompt'])
        expect((result.parsedInput as Record<string, unknown>).n).toBeUndefined()
        expect((result.parsedInput as Record<string, unknown>).size).toBeUndefined()
        expect(
          (result.parsedInput as Record<string, unknown>).aspectRatio,
        ).toBeUndefined()
      }
    })

    // variant-resolution test removed — Variant axis deleted,
    // ResolvedDispatchTarget no longer carries a `variant` field.

    it('resolves meta Pattern (no primary split)', () => {
      const registry = freshRegistry([
        createImageToImageViaCaptionPattern() as never as Pattern,
        createTextToImagePattern() as never as Pattern,
        createImageToImagePattern() as never as Pattern,
      ])
      const result = resolveDispatchTarget(
        registry,
        {
          pattern_id: 'meta_image-to-image-via-caption',
          input: { editPrompt: 'make it cyberpunk' },
        },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(false)
      if (!isDispatchError(result)) {
        expect(result.pattern.id).toBe('meta_image-to-image-via-caption')
        expect(result.parsedInput.editPrompt).toBe('make it cyberpunk')
      }
    })

    // Positive twin of the bad_slot rejection test: a VALID declared slot must
    // parse and survive into parsedInput for the host resolution pass — guards
    // against the derived schema ever rejecting/stripping legitimate handles.
    it('accepts a valid declared references slot on a meta Pattern and keeps it in parsedInput', () => {
      const registry = freshRegistry([
        createImageToImageViaCaptionPattern() as never as Pattern,
      ])
      const result = resolveDispatchTarget(
        registry,
        {
          pattern_id: 'meta_image-to-image-via-caption',
          input: { editPrompt: 'make it neon', references: { source: 'image_1' } },
        },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(false)
      if (!isDispatchError(result)) {
        // Required-ness lives in the host default rule, not zod, so the
        // slot is optional at parse; when provided it must come through intact.
        expect(result.parsedInput.references).toEqual({ source: 'image_1' })
      }
    })

    it('resolves variantless Pattern (single primary path)', () => {
      const registry = freshRegistry([
        createTextGenerationPattern() as never as Pattern,
      ])
      const result = resolveDispatchTarget(
        registry,
        { pattern_id: 'text-generation', input: { prompt: 'summarize this' } },
        'chat-turn',
      )
      expect(isDispatchError(result)).toBe(false)
      if (!isDispatchError(result)) {
        expect(result.pattern.id).toBe('text-generation')
      }
    })
  })
})
