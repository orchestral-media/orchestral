import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as root from '../index'
import * as memory from '../memory'
import * as routing from '../routing'

// Subpath entries as a checkable claim.
//
// "core is the vocabulary" was, until now, only prose: with a single `.` entry
// a host had no way to import the contracts without also naming the in-memory
// stores and the default router. The split does not move a line of logic — it
// gives the sentence an import statement that can falsify it.
//
// Which is why the root barrel does not keep a re-export: a deprecated alias
// would leave both spellings resolvable, and the claim would go back to being
// prose. The moved symbols must be UNREACHABLE from `@orchestral/core` for the
// entry list to mean anything.
//
// Two things are pinned here because nothing else pins them: the exports map
// itself (a typo in package.json is invisible to tsc and to every test that
// imports relatively), and the absence of a re-export in the barrel SOURCE —
// `Object.keys` alone cannot see a `export type` shim, and a value alias
// re-added "just for one release" would sail past a keys-only check the moment
// it is written as a type.

const PKG = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  exports: Record<string, string>
  publishConfig: { exports: Record<string, { types: string; import: string }> }
}

const INDEX_SRC = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

/**
 * The barrel with its `//` comments stripped — i.e. the export statements
 * alone. The comments are where the barrel POINTS AT the new homes, so they
 * name the moved symbols on purpose; only the code may not.
 */
const INDEX_CODE = INDEX_SRC.replace(/^\s*\/\/.*$/gm, '')

/** Every symbol that moved out of the barrel, in both directions. */
const RELOCATED = [
  'InMemoryJobStore',
  'InMemoryAssetStore',
  'InMemoryTranscriptStore',
  'createDefaultCapabilityRouter',
  'NoModelForCapabilityError',
  'ModelExcludedError',
  'DefaultCapabilityRouterDeps',
] as const

describe('@orchestral/core subpath entries', () => {
  it('package.json declares both subpaths, in dev and in publishConfig', () => {
    expect(PKG.exports).toEqual({
      '.': './src/index.ts',
      './memory': './src/memory.ts',
      './routing': './src/routing.ts',
    })
    expect(PKG.publishConfig.exports['./memory']).toEqual({
      types: './dist/memory.d.ts',
      import: './dist/memory.js',
    })
    expect(PKG.publishConfig.exports['./routing']).toEqual({
      types: './dist/routing.d.ts',
      import: './dist/routing.js',
    })
  })

  it('the root barrel no longer answers for anything the subpaths own', () => {
    for (const name of [...Object.keys(memory), ...Object.keys(routing)]) {
      expect(root, `root barrel still exports ${name}`).not.toHaveProperty(name)
    }
  })

  it('and no re-export shim was left behind in the barrel source', () => {
    // `./asset-store` and `./transcript-store` are still named by the barrel,
    // and must be: it keeps exporting their contract TYPES. That is the split —
    // the interface is vocabulary, the implementation is a battery — so the
    // claim is about the symbols, not the modules.
    for (const name of RELOCATED) {
      expect(INDEX_CODE, `index.ts still exports ${name}`).not.toContain(name)
    }
    // A shim would have to announce itself; none may exist anywhere on the
    // barrel. The project has no released users to carry, so a deprecation
    // window would buy an ambiguity nobody asked for.
    expect(INDEX_SRC).not.toContain('@deprecated')
  })
})
