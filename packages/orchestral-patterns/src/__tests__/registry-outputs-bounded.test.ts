// Registering the whole shipped catalog must not trip the registry's own
// authoring lint. `PatternRegistry.register` audits every outputs schema
// (`auditOutputsSchema`) and warns `OUTPUTS_UNBOUNDED_FIELDS` for any bare
// z.string() — and `OUTPUTS_UNAUDITED_FIELDS` for any shape the walk cannot
// see into. DESIGN.md's rule is that an output schema never carries an
// unbounded string; this is the gate that keeps the first-party catalog
// honest about it. The bounds themselves are tabled in the README under
// "Conventions" so they can be retuned in one place.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PatternRegistry, type DiagnosticsLogger } from '@orchestral/core'

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
}

function recordingLogger() {
  const warned: string[] = []
  const errored: string[] = []
  const logger: DiagnosticsLogger = {
    warn: (message) => {
      warned.push(message)
    },
    error: (message) => {
      errored.push(message)
    },
  }
  return { logger, warned, errored }
}

describe('shipped catalog outputs are bounded', () => {
  it('registering every first-party pattern logs no OUTPUTS_UNBOUNDED_FIELDS (or any other) warning', () => {
    const { logger, warned, errored } = recordingLogger()
    const registry = new PatternRegistry({ logger })

    const result = registry.addFromManifest(pkg.orchestral, patterns, OPS)

    // The whole catalog, not a subset — a pattern skipped for want of an op
    // would be a pattern this test never audited.
    expect(result.skipped).toEqual([])
    expect(registry.size()).toBe(result.registered.length)

    expect(warned).toEqual([])
    expect(errored).toEqual([])
  })
})
