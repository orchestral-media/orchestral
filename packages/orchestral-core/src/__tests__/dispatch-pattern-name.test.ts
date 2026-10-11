// resolveDispatchTarget and the reserved `name` field. On a Pattern whose
// outputs carry assets[], registration puts the field in the schema and the
// parse judges the name like any other field. On one whose outputs do not,
// the parse cannot see it (dispatch parses passthrough), so the resolver
// refuses it itself: a name nothing would ever record under is a promise the
// call cannot keep, and dropping it would let the model cite a handle that
// never comes to exist.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineAtomicPattern } from '../atomic-pattern'
import {
  type DispatchPatternError,
  type ResolvedDispatchTarget,
  isDispatchError,
  resolveDispatchTarget,
} from '../dispatch-pattern'
import type { ZodSchema } from '../foundational'
import { silentDiagnosticsLogger } from '../logger'
import { producedAssetShape } from '../output-envelope'
import { boundedText } from '../output-fields'
import type { PatternExposure } from '../pattern'
import { PatternRegistry } from '../registry'

function atomic(id: string, outputs: z.ZodType, exposure?: PatternExposure) {
  return defineAtomicPattern({
    id,
    description: id,
    ...(exposure !== undefined ? { exposure } : {}),
    primary: {
      tool: { description: id, inputs: z.object({ prompt: z.string() }) as unknown as ZodSchema },
      modelTags: [],
    },
    outputs: outputs as unknown as ZodSchema,
  })
}

const WRITER = 'test-writer' // outputs text, no assets[]
const PAINTER = 'test-painter' // outputs assets[]
const HIDDEN_WRITER = 'test-hidden-writer'

const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
registry.register(atomic(WRITER, z.object({ text: boundedText(4_096) })))
registry.register(atomic(PAINTER, z.object({ assets: z.array(z.object(producedAssetShape('image'))) })))
registry.register(atomic(HIDDEN_WRITER, z.object({ text: boundedText(4_096) }), 'no-tool'))

function dispatch(pattern_id: string, input: Record<string, unknown>) {
  return resolveDispatchTarget(registry, { pattern_id, input }, 'chat-turn')
}

function failureOf<C extends DispatchPatternError['code']>(
  r: ResolvedDispatchTarget | DispatchPatternError,
  code: C,
): Extract<DispatchPatternError, { code: C }> {
  if (!isDispatchError(r) || r.code !== code) throw new Error(`expected ${code}, got ${isDispatchError(r) ? r.code : 'a resolved target'}`)
  return r as Extract<DispatchPatternError, { code: C }>
}

function issuesOf(r: ResolvedDispatchTarget | DispatchPatternError) {
  return failureOf(r, 'INPUT_VALIDATION_FAILED').issues
}

const MINT_GRAMMAR_MESSAGE =
  'name must not have the shape of a generated handle (<kind>_<n>, e.g. image_3): those are assigned by the ledger. Pick another name, or omit name.'

describe('resolveDispatchTarget — a name on a Pattern that records no assets', () => {
  it('refuses a name on a Pattern whose outputs declare no assets', () => {
    expect(issuesOf(dispatch(WRITER, { prompt: 'a poem', name: 'hero' }))).toEqual([
      {
        code: 'custom',
        path: ['name'],
        input: 'hero',
        message: `Pattern "${WRITER}" produces no assets, so nothing would be recorded under name "hero". Omit name for this Pattern.`,
      },
    ])
  })

  it('a blank name on such a Pattern is absent, not refused', () => {
    for (const name of ['', '   ', 'asset://']) {
      const r = dispatch(WRITER, { prompt: 'a poem', name })
      expect(isDispatchError(r), JSON.stringify(name)).toBe(false)
    }
  })

  it('reports the refused name with refused input fields, input issues first', () => {
    const issues = issuesOf(dispatch(WRITER, { name: ' asset://hero ' }))
    expect(issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'invalid_type', path: ['prompt'] },
      { code: 'custom', path: ['name'] },
    ])
    // The raw value is what was sent; the message names it as it would be recorded.
    expect(issues[1]).toMatchObject({ input: ' asset://hero ', message: expect.stringContaining('name "hero"') })
  })

  it('judges the Pattern before the name', () => {
    failureOf(dispatch('test-no-such-pattern', { prompt: 'a poem', name: 'hero' }), 'PATTERN_NOT_FOUND')
    failureOf(dispatch(HIDDEN_WRITER, { prompt: 'a poem', name: 'hero' }), 'PATTERN_NOT_DISPATCHABLE')
  })
})

describe('resolveDispatchTarget — a name on a Pattern that records assets', () => {
  it('a free name on a producer reaches the parsed input as written', () => {
    const r = dispatch(PAINTER, { prompt: 'a lighthouse', name: 'hero' })
    if (isDispatchError(r)) throw new Error(`expected a resolved target, got ${r.code}`)
    expect(r.parsedInput.name).toBe('hero')
  })

  it('a bad name on a producer is an input issue at path name', () => {
    expect(
      issuesOf(dispatch(PAINTER, { prompt: 'a lighthouse', name: 'image_3' })).map(({ code, path, message }) => ({
        code,
        path,
        message,
      })),
    ).toEqual([{ code: 'custom', path: ['name'], message: MINT_GRAMMAR_MESSAGE }])
  })
})
