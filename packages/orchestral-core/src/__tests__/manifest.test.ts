import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineAtomicPattern } from '../atomic-pattern'
import { ManifestError, OrchestralManifestSchema } from '../manifest'
import { PatternRegistry } from '../registry'

// @orchestral/patterns is the first package to follow the convention, so it is
// also the only honest test of it — a hand-written fixture would prove the
// loader parses a fixture. Core cannot depend on patterns (patterns depends on
// core), so the package is read the way a host would read a published one: its
// package.json off disk, its entry point through a plain import.
const PATTERNS_PKG = new URL('../../../orchestral-patterns/', import.meta.url)

interface PatternsPkg {
  keywords?: readonly string[]
  orchestral?: unknown
}

let pkg: PatternsPkg
let patternsModule: Readonly<Record<string, unknown>>

beforeAll(async () => {
  pkg = JSON.parse(
    readFileSync(new URL('package.json', PATTERNS_PKG), 'utf8'),
  ) as PatternsPkg
  patternsModule = (await import(
    /* @vite-ignore */ new URL('src/index.ts', PATTERNS_PKG).href
  )) as Readonly<Record<string, unknown>>
})

/** Host ops @orchestral/patterns declares — stubs; nothing dispatches here. */
const OPS = {
  concatVideos: async () => ({ assetId: 'v' }),
  stillToVideo: async () => ({ assetId: 'v' }),
  addBackgroundAudio: async () => ({ assetId: 'v' }),
  addSubtitles: async () => ({ assetId: 'v' }),
  createSubtitleAsset: async () => ({ assetId: 's' }),
  recordSessionAsset: async () => ({ handle: 'image_1' }),
}

describe('@orchestral/patterns manifest', () => {
  it('declares itself discoverable by keyword', () => {
    expect(pkg.keywords).toContain('orchestral-pattern')
  })

  it('registers every declared pattern from the real manifest + module', () => {
    const manifest = OrchestralManifestSchema.parse(pkg.orchestral)
    const registry = new PatternRegistry()

    const result = registry.addFromManifest(pkg.orchestral, patternsModule, OPS)

    expect(result.registered).toEqual(manifest.patterns.map((p) => p.id))
    expect(result.skipped).toEqual([])
    expect(registry.size()).toBe(manifest.patterns.length)
    for (const entry of manifest.patterns) {
      expect(registry.get(entry.id)?.kind).toBe(entry.kind)
    }
  })

  it('declares host ops per pattern, so the ffmpeg-free subset still loads', () => {
    const manifest = OrchestralManifestSchema.parse(pkg.orchestral)
    // The claim that makes per-pattern requiredOps worth having: the patterns
    // that need nothing outnumber the ones that do, and a host without ffmpeg
    // must still get them.
    const needOps = manifest.patterns.filter((p) => p.requiredOps?.length)
    expect(needOps.length).toBeGreaterThan(0)
    expect(needOps.length).toBeLessThan(manifest.patterns.length)
    // Every declared op is one the meta authoring surface actually names.
    for (const entry of needOps) {
      for (const op of entry.requiredOps ?? []) {
        expect(Object.keys(OPS)).toContain(op)
      }
    }

    const registry = new PatternRegistry()
    const result = registry.addFromManifest(
      pkg.orchestral,
      patternsModule,
      undefined,
      { missingOps: 'skip' },
    )

    expect(result.registered).toEqual(
      manifest.patterns.filter((p) => !p.requiredOps?.length).map((p) => p.id),
    )
    expect(result.skipped.map((s) => s.id)).toEqual(needOps.map((p) => p.id))
    // The report says WHICH op was missing — a skipped pattern that only shows
    // up as a routing miss hours later is the failure mode this prevents.
    for (const skip of result.skipped) {
      expect(skip.missingOps.length).toBeGreaterThan(0)
    }
    expect(registry.size()).toBe(result.registered.length)
  })

  it('loads just the patterns a host asks for with { only }', () => {
    const registry = new PatternRegistry()

    const result = registry.addFromManifest(
      pkg.orchestral,
      patternsModule,
      undefined,
      { only: ['text-to-image', 'image-to-text'] },
    )

    expect(result.registered).toEqual(['text-to-image', 'image-to-text'])
    expect(registry.size()).toBe(2)
  })

  it('rejects an { only } id the manifest does not declare', () => {
    const registry = new PatternRegistry()
    let thrown: unknown
    try {
      registry.addFromManifest(pkg.orchestral, patternsModule, OPS, {
        only: ['text-to-image', 'no-such-pattern'],
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ManifestError)
    expect((thrown as ManifestError).code).toBe('MANIFEST_UNKNOWN_PATTERN')
    expect((thrown as ManifestError).message).toContain('no-such-pattern')
    expect(registry.size()).toBe(0)
  })

  it('declares every pattern factory the package exports', () => {
    const manifest = OrchestralManifestSchema.parse(pkg.orchestral)
    const declared = new Set(manifest.patterns.map((p) => p.export))
    // The package names every pattern factory `create*`; anything matching that
    // and missing from the manifest is a pattern a host loading by manifest
    // would silently not get.
    const exported = Object.keys(patternsModule).filter((name) =>
      name.startsWith('create'),
    )
    expect(exported.filter((name) => !declared.has(name))).toEqual([])
  })

  it('refuses to load when a declared host op is missing', () => {
    const registry = new PatternRegistry()
    const { concatVideos: _dropped, ...partial } = OPS
    let thrown: unknown
    try {
      registry.addFromManifest(pkg.orchestral, patternsModule, partial)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ManifestError)
    expect((thrown as ManifestError).code).toBe('MANIFEST_MISSING_OPS')
    expect((thrown as ManifestError).message).toContain('concatVideos')
    // Ops are checked before any factory runs.
    expect(registry.size()).toBe(0)
  })
})

// ── Validation / wiring failures (synthetic module) ────────────────────────

const okPattern = () =>
  defineAtomicPattern({
    id: 'text-to-image',
    description: 'test',
    primary: {
      tool: { description: 'test', inputs: z.object({}) },
      modelTags: [],
    },
    outputs: z.object({}),
  })

const MODULE = {
  makePattern: okPattern,
  makeOther: () =>
    defineAtomicPattern({
      id: 'image-to-text',
      description: 'test',
      primary: {
        tool: { description: 'test', inputs: z.object({}) },
        modelTags: [],
      },
      outputs: z.object({}),
    }),
  notAFactory: 'nope',
}

function expectManifestError(fn: () => unknown, code: string): ManifestError {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(ManifestError)
  expect((thrown as ManifestError).code).toBe(code)
  return thrown as ManifestError
}

describe('addFromManifest validation', () => {
  it('rejects a manifest that does not parse', () => {
    const registry = new PatternRegistry()
    expectManifestError(
      () => registry.addFromManifest({ patterns: [] }, MODULE),
      'MANIFEST_INVALID',
    )
    expectManifestError(
      () => registry.addFromManifest(undefined, MODULE),
      'MANIFEST_INVALID',
    )
    // kind must be carried by the id — a meta declared with a bare id would
    // land in the wrong namespace and escape the sub-agent recursion guard.
    const err = expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'meta', export: 'makePattern' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_INVALID',
    )
    expect(err.message).toContain('patterns.0')
  })

  it('rejects duplicate pattern ids inside one manifest', () => {
    const registry = new PatternRegistry()
    expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
              { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_INVALID',
    )
  })

  it('names the export when the module has no such factory', () => {
    const registry = new PatternRegistry()
    const err = expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'atomic', export: 'makeRenamed' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_EXPORT_MISSING',
    )
    expect(err.message).toContain('makeRenamed')
  })

  it('rejects an export that is not callable', () => {
    const registry = new PatternRegistry()
    expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'atomic', export: 'notAFactory' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_EXPORT_NOT_A_FACTORY',
    )
  })

  it('rejects a factory whose pattern contradicts the declaration', () => {
    const registry = new PatternRegistry()
    const err = expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-video', kind: 'atomic', export: 'makePattern' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_PATTERN_MISMATCH',
    )
    expect(err.message).toContain('text-to-image')
    expect(err.message).toContain('text-to-video')
  })

  it('registers nothing when a later entry fails', () => {
    const registry = new PatternRegistry()
    expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
              { id: 'image-to-text', kind: 'atomic', export: 'makeGone' },
            ],
          },
          MODULE,
        ),
      'MANIFEST_EXPORT_MISSING',
    )
    expect(registry.size()).toBe(0)
  })

  it('loads a manifest that declares no host ops without an ops argument', () => {
    const registry = new PatternRegistry()
    const result = registry.addFromManifest(
      {
        patterns: [
          { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
          { id: 'image-to-text', kind: 'atomic', export: 'makeOther' },
        ],
      },
      MODULE,
    )
    expect(result.registered).toEqual(['text-to-image', 'image-to-text'])
    expect(result.skipped).toEqual([])
    expect(registry.has('image-to-text')).toBe(true)
  })

  it('rejects a package-level requiredOps instead of ignoring it', () => {
    // The field moved to the entries. Ignoring it would drop a fail-closed op
    // declaration on the floor — the one outcome worse than refusing to load.
    const registry = new PatternRegistry()
    expectManifestError(
      () =>
        registry.addFromManifest(
          {
            patterns: [
              { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
            ],
            requiredOps: ['concatVideos'],
          },
          MODULE,
        ),
      'MANIFEST_INVALID',
    )
    expect(registry.size()).toBe(0)
  })

  it("skips only the entries whose ops are missing under missingOps: 'skip'", () => {
    const registry = new PatternRegistry()
    const result = registry.addFromManifest(
      {
        patterns: [
          { id: 'text-to-image', kind: 'atomic', export: 'makePattern' },
          {
            id: 'image-to-text',
            kind: 'atomic',
            export: 'makeOther',
            requiredOps: ['concatVideos'],
          },
        ],
      },
      MODULE,
      undefined,
      { missingOps: 'skip' },
    )
    expect(result.registered).toEqual(['text-to-image'])
    expect(result.skipped).toEqual([
      { id: 'image-to-text', missingOps: ['concatVideos'] },
    ])
    expect(registry.has('image-to-text')).toBe(false)
  })
})
