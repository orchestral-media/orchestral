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
    const result = registry.addFromManifest(pkg.orchestral, agent)

    expect(result.registered).toEqual(manifest.patterns.map((p) => p.id))
    // Neither agent needs a host op, so nothing is ever skipped for want of one
    // and the package loads with no `ops` argument at all.
    expect(result.skipped).toEqual([])
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
    // keeps the comparison to Pattern factories even if a future non-Pattern
    // `create*` helper is exported alongside them.
    const exported = Object.keys(agent).filter(
      (name) => name.startsWith('create') && name.endsWith('Agent'),
    )
    expect(exported.length).toBeGreaterThan(0)
    expect(exported.filter((name) => !declared.has(name))).toEqual([])
  })
})
