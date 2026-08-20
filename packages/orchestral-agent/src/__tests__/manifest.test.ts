import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OrchestralManifestSchema, PatternRegistry } from '@orchestral/core'

import * as agent from '../index'

// The same drift gate @orchestral/core runs against @orchestral/patterns, kept
// local to this package: the `"orchestral"` manifest is read WITHOUT executing
// the package (`npm view @orchestral/agent orchestral`), so it goes stale
// silently unless something checks it against the real exports.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { keywords?: readonly string[]; orchestral?: unknown }

describe('@orchestral/agent manifest', () => {
  it('declares itself discoverable by keyword', () => {
    expect(pkg.keywords).toContain('orchestral-pattern')
  })

  it('registers both agent patterns from the real manifest + module', () => {
    const manifest = OrchestralManifestSchema.parse(pkg.orchestral)
    const registry = new PatternRegistry()

    // No ops argument: neither agent takes host operations, so the manifest
    // declares no `requiredOps`.
    const ids = registry.addFromManifest(pkg.orchestral, agent)

    expect(ids).toEqual(manifest.patterns.map((p) => p.id))
    expect(registry.size()).toBe(manifest.patterns.length)
    for (const entry of manifest.patterns) {
      expect(registry.get(entry.id)?.kind).toBe('agent')
    }
  })

  it('declares every agent factory the package exports', () => {
    const manifest = OrchestralManifestSchema.parse(pkg.orchestral)
    const declared = new Set(manifest.patterns.map((p) => p.export))
    // Pattern factories in this package are named `create*Agent`. The narrower
    // suffix (core's guard over @orchestral/patterns matches bare `create*`)
    // keeps `createInProcessAgentRunImpl` — a runner, not a Pattern — out of
    // the comparison.
    const exported = Object.keys(agent).filter(
      (name) => name.startsWith('create') && name.endsWith('Agent'),
    )
    expect(exported.length).toBeGreaterThan(0)
    expect(exported.filter((name) => !declared.has(name))).toEqual([])
  })
})
