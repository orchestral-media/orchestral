// The package's own paperwork, pinned. Every field below is a field a sibling
// package (discovery, runtime) already carries, and getting one wrong does not
// fail a build in this workspace — `main` points at src here, and
// publishConfig's dist mapping is applied by npm only at publish time. So the
// tarball a consumer installs is exactly what is NOT exercised by any other
// test; this file is the cheap standing check that it stays shaped like its
// siblings.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  type: string
  main: string
  types: string
  sideEffects: boolean
  exports: Record<string, unknown>
  files: string[]
  publishConfig: {
    main: string
    types: string
    exports: Record<string, { types: string; import: string }>
  }
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  scripts: Record<string, string>
}

describe('@orchestral/plan package wiring', () => {
  it('resolves in the workspace as ESM off src, and publishes off dist', () => {
    expect(pkg.name).toBe('@orchestral/plan')
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.main).toBe('./src/index.ts')
    expect(pkg.types).toBe('./src/index.ts')
    expect(pkg.exports).toEqual({ '.': './src/index.ts' })
    expect(pkg.publishConfig.main).toBe('./dist/index.js')
    expect(pkg.publishConfig.types).toBe('./dist/index.d.ts')
    expect(pkg.publishConfig.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    })
    expect(pkg.files).toEqual(['dist', 'NOTICE', 'CHANGELOG.md'])
  })

  it('depends on core and nothing else; zod is a peer, as in every sibling', () => {
    expect(pkg.dependencies).toEqual({ '@orchestral/core': 'workspace:*' })
    expect(pkg.peerDependencies).toEqual({ zod: '>=4.3 <5' })
  })

  it('carries the four-command script block the release pipeline calls', () => {
    expect(pkg.scripts.build).toBe(
      'tsdown && tsc -p tsconfig.build.json && api-extractor run',
    )
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit')
    expect(pkg.scripts.test).toBe('vitest run')
  })
})
