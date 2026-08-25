// Every shipped meta declares what it will dispatch.
//
// `MetaPattern.plannedDispatches` is what lets an agent loop hold a meta's
// inner steps to its own allowlist before anything is submitted: a meta that
// declares is pre-checked, a meta that does not is dispatched with no check on
// what it steps into. That makes declaring a property of the CATALOG, not of
// any one meta — the moment one shipped meta omits it, an agent granted that
// meta is granted whatever the meta calls, and nothing says so.
//
// So this is a sweep over the registered catalog rather than a list of ids:
// a meta added tomorrow is covered the day it is registered, and a meta that
// forgets the declaration fails here instead of shipping the hole. The exact
// id lists live with each meta's own tests; what is pinned here is that a
// declaration exists, survives a garbage input, and names only patterns this
// package actually ships.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PatternRegistry, type MetaPattern, type PatternId } from '@orchestral/core'

import * as patterns from '../index'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { orchestral: unknown }

/** Host ops the manifest declares — stubs; nothing dispatches here. */
const OPS = {
  concatVideos: async () => ({ assetId: 'v' }),
  stillToVideo: async () => ({ assetId: 'v' }),
  addBackgroundAudio: async () => ({ assetId: 'v' }),
  addSubtitles: async () => ({ assetId: 'v' }),
  createSubtitleAsset: async () => ({ assetId: 's' }),
  recordSessionAsset: async () => ({ handle: 'image_1' }),
  getPattern: () => undefined,
}

function shippedMetas(): { registry: PatternRegistry; metas: readonly MetaPattern[] } {
  const registry = new PatternRegistry()
  const result = registry.addFromManifest(pkg.orchestral, patterns, OPS)
  // The whole catalog, not a subset — a pattern skipped for want of an op
  // would be a meta this sweep never looked at.
  expect(result.skipped).toEqual([])
  const metas = [...registry.values()].filter(
    (p): p is MetaPattern => p.kind === 'meta',
  )
  return { registry, metas }
}

describe('the shipped catalog declares its meta dispatches', () => {
  it('every kind:"meta" pattern the manifest builds declares plannedDispatches', () => {
    const { metas } = shippedMetas()
    // Guard the guard: an empty list would make the assertion below vacuous.
    expect(metas.length).toBeGreaterThan(0)
    const undeclared = metas
      .filter((m) => typeof m.plannedDispatches !== 'function')
      .map((m) => m.id)
    expect(undeclared).toEqual([])
  })

  it('every declaration is total — the dispatch path may call it with anything', () => {
    // The declaration runs before `tool.inputs` has necessarily parsed
    // anything (a host-direct submit never parses), and the runtime treats a
    // throw as "undeclared" — silently losing the check. So a declaration that
    // throws on a malformed input is a hole with a log line, not a failure.
    const { metas } = shippedMetas()
    for (const meta of metas) {
      for (const input of [undefined, null, {}, 42, { steps: 'not-an-array' }]) {
        const declared = meta.plannedDispatches?.(input as never)
        expect(Array.isArray(declared), `${meta.id} returned a list`).toBe(true)
        for (const id of declared ?? []) {
          expect(typeof id, `${meta.id} declared a string id`).toBe('string')
        }
      }
    }
  })

  it('nothing is declared that this catalog does not ship', () => {
    // A typo'd or stale id in a declaration is worse than no declaration: the
    // guard would refuse every call from an agent that could never have listed
    // an id no registry resolves. Checked against the catalog these metas are
    // registered in, with the malformed-input answer included — that is the
    // branch a defensive read falls back to.
    const { registry, metas } = shippedMetas()
    for (const meta of metas) {
      const declared: PatternId[] = [
        ...(meta.plannedDispatches?.({} as never) ?? []),
        ...(meta.plannedDispatches?.(SAMPLE_INPUTS[meta.id] as never) ?? []),
      ]
      for (const id of declared) {
        expect(registry.has(id), `${meta.id} declares ${id}, which is registered`).toBe(
          true,
        )
      }
    }
  })
})

// One representative input per meta whose declaration reads it. Everything
// else ignores its input, and `{}` above already covers those; `meta_plan` is
// the interpreter, so its "dispatch set" is whatever DAG it is handed.
const SAMPLE_INPUTS: Record<string, unknown> = {
  'meta_image-best-of-n': {
    innerPatternId: 'text-to-image',
    innerInput: { prompt: 'a red bicycle' },
    n: 2,
    targetDescription: 'a red bicycle',
  },
  meta_plan: {
    steps: [{ id: 'render', pattern: 'text-to-image', input: { prompt: 'x' } }],
  },
}
