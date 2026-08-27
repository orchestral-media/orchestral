// Directory-as-contract guard for src/atomic.
//
// `src/atomic` holds thin capability declarations — schema plus
// `defineAtomicPattern` — and `src/meta` holds the compositions. That was
// prose until `meta_image-to-image-via-caption` sat in atomic/ declaring
// `kind: 'meta'` while atomic/image-to-image.ts imported it back, which put an
// atomic → meta → atomic loop inside the package and made the directory name
// misleading for the two most-read files in it.
//
// Nothing in the type system says a file's directory must match the `kind` it
// declares, so the rule held only as long as every author remembered it. This
// scan is the same move as public-surface.test.ts's export snapshot, applied
// to a directory instead of a surface.
//
// One atomic → meta edge is allowed and named here: image-to-image imports the
// finished `VIA_CAPTION_ALTERNATIVE` object. An Alternative is a statement
// about the chain it redirects into, so it is authored beside that chain; the
// import is the Alternative relation itself, not a composition dependency.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ATOMIC_DIR = fileURLToPath(new URL('../atomic/', import.meta.url))
const VIA_CAPTION_FILE = fileURLToPath(
  new URL('../meta/image-to-image-via-caption/index.ts', import.meta.url),
)

const atomicSources: readonly (readonly [string, string])[] = readdirSync(ATOMIC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => [f, readFileSync(join(ATOMIC_DIR, f), 'utf8')] as const)

/** Module specifiers of every `from '…'` in a source file. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
}

describe('src/atomic holds atomic Patterns only', () => {
  it('has files to scan', () => {
    // Guards the two scans below against a silently-empty glob.
    expect(atomicSources.length).toBeGreaterThan(5)
  })

  it('declares no MetaPattern', () => {
    const metas = atomicSources.filter(([, src]) => src.includes("kind: 'meta'")).map(([f]) => f)
    expect(metas).toEqual([])
  })

  it('reaches into ../meta only for the Alternative image-to-image ships', () => {
    const reaching = atomicSources
      .filter(([, src]) => importsOf(src).some((spec) => spec.startsWith('../meta/')))
      .map(([f]) => f)
    expect(reaching).toEqual(['image-to-image.ts'])
  })
})

describe('the via-caption meta', () => {
  const src = readFileSync(VIA_CAPTION_FILE, 'utf8')

  it('is where the Alternative image-to-image redirects through is authored', () => {
    expect(src).toContain('export const VIA_CAPTION_ALTERNATIVE')
  })

  it('does not import back into atomic/image-to-image (no cycle)', () => {
    const specs = importsOf(src)
    // The two sub-steps it really composes — the edge that must exist.
    expect(specs).toContain('../../atomic/image-to-text')
    expect(specs).toContain('../../atomic/text-to-image')
    // The edge that must not: importing the redirecting parent's types back
    // here would re-close the loop this move opened.
    expect(specs).not.toContain('../../atomic/image-to-image')
  })
})
