import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Pattern } from '../pattern'
import { PatternRegistry } from '../registry'
import { silentDiagnosticsLogger } from '../logger'

// Surface-drift guard for the registry and the manifest's id↔kind contract.
//
// Three claims, none of which the type system can hold:
//   • `listForCatalog` is gone. It was public API with no caller anywhere in
//     the repo, and it silently returned atomics only — a filter its name did
//     not mention. `[...registry].filter(p => p.kind === 'atomic')` is one line
//     and shows the filter.
//   • `add` is gone. The `spec.alternatives` expansion it was named for moved
//     into `register`, so it had been a one-line passthrough since — two names
//     for one entry point, with a class doc still describing a layering between
//     them. `PatternScope.add` keeps its name: that one is the scope's verb.
//   • `idCarriesKind` carries ONE JSDoc block. It had two, of which TypeScript
//     read the second and a reader read whichever they hit first.
//
// Same move as error-code-convention.test.ts: turn "remember to" into a test.

const REGISTRY_SRC = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8')
const MANIFEST_SRC = readFileSync(new URL('../manifest.ts', import.meta.url), 'utf8')

/**
 * The comment blocks attached to a top-level `decl` — i.e. everything between
 * the end of the previous top-level statement and the declaration itself.
 */
function attachedComments(src: string, decl: string): string {
  const at = src.indexOf(decl)
  expect(at, `declaration not found: ${decl}`).toBeGreaterThan(-1)
  const prevStatementEnd = src.lastIndexOf('\n}\n', at)
  expect(
    prevStatementEnd,
    `no preceding top-level statement before: ${decl}`,
  ).toBeGreaterThan(-1)
  return src.slice(prevStatementEnd, at)
}

function atomic(id: string): Pattern {
  return {
    id,
    kind: 'atomic',
    description: `do ${id}`,
    primary: {
      tool: { description: `do ${id}`, inputs: z.object({ prompt: z.string() }) },
    },
    outputs: z.object({ modality: z.literal('image') }),
  } as unknown as Pattern
}

describe('PatternRegistry surface', () => {
  it('listForCatalog is gone', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect('listForCatalog' in registry).toBe(false)
    expect(REGISTRY_SRC).not.toContain('listForCatalog')
  })

  it('the one-liner that replaces it is visible about its filter', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    registry.register(atomic('text-to-image'))
    registry.register({
      ...atomic('meta_thing'),
      kind: 'meta',
      tool: { description: 'm', inputs: z.object({ prompt: z.string() }) },
      compose: async () => ({}),
    } as unknown as Pattern)
    const atomics = [...registry].filter((p) => p.kind === 'atomic')
    expect(atomics.map((p) => p.id)).toEqual(['text-to-image'])
  })

  it('register is the only registration entry point — the add alias is gone', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect('add' in registry).toBe(false)
    registry.register(atomic('text-to-image'))
    expect(registry.get('text-to-image')?.id).toBe('text-to-image')
  })

  it('a scope still says add — that one is the scope’s own verb', () => {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    const scope = registry.scope()
    scope.add(atomic('text-to-image'))
    expect(registry.get('text-to-image')?.id).toBe('text-to-image')
    scope.dispose()
    expect(registry.has('text-to-image')).toBe(false)
  })

  it('the class doc no longer describes a layering that does not exist', () => {
    const classDoc = REGISTRY_SRC.slice(
      0,
      REGISTRY_SRC.indexOf('export class PatternRegistry'),
    )
    expect(classDoc).not.toContain('the single registration entry point')
    expect(classDoc).not.toContain('lower-level accessors')
  })
})

describe('manifest id↔kind contract', () => {
  it('idCarriesKind carries exactly one JSDoc block', () => {
    const doc = attachedComments(MANIFEST_SRC, 'export function idCarriesKind(')
    expect(doc.match(/\/\*\*/g) ?? []).toHaveLength(1)
  })

  it('the surviving block keeps both halves of the argument', () => {
    const doc = attachedComments(MANIFEST_SRC, 'export function idCarriesKind(')
    // why the prefix is normative …
    expect(doc).toContain('DEFAULT_SUBAGENT_BLOCKLIST')
    // … and why checking it here is not enough on its own.
    expect(doc).toContain('PatternRegistry.register')
    // The merge must not drop DESIGN.md's handle on the argument. (The repo's
    // design-anchors test would catch a deletion; this says which block owns
    // it, so a future re-split cannot leave it on the wrong half.)
    expect(doc).toContain('DESIGN: id-carries-kind')
  })
})
