// Source-level drift guard for DESIGN.md's citations.
//
// Every refusal in DESIGN.md ends in a `Where.` segment, and the document's
// whole claim to be checkable — P18's "each refusal is argued at a location you
// can open" — rests on those citations landing on the argument they quote.
// They named line ranges, and line ranges rot in silence: 19 of the 52
// non-test citations named a range that had already moved, concentrated in the
// files that change most (pattern.ts, registry.ts, agent-dispatch.ts,
// inline.ts). A stale citation is worse than no citation, because it reads as
// verified.
//
// So a citation now names an ANCHOR the cited file carries in a comment, and
// this test is what makes the pair hold in both directions:
//   • every anchor a citation names appears exactly once in the file it names
//   • every anchor in the tree is named by some citation
// The first catches a deleted or renamed argument; the second catches an
// argument that outlived the entry citing it. Moving the code moves the anchor
// with it, which is the whole point — an editor who never opens DESIGN.md
// cannot break the citation by reformatting.
//
// Test-file citations carry an `it()` / `describe()` title instead of an
// anchor. A test's name is a better handle than its line, the title already
// states what the test pins, and renaming the test should break the citation.
//
// Same move as error-code-convention.test.ts in @orchestral/runtime: turn a
// convention nothing enforces into a failing test rather than a habit.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../', import.meta.url).pathname
const DESIGN = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')

/** `` `path/to/file.ts` (DESIGN: some-slug) `` — the anchored citation form. */
const CITATION = /`([^`\n]+?)`\s*\(DESIGN:\s*([a-z][a-z0-9-]*)\)/g

/** `` `…/__tests__/foo.test.ts` ("an it title") `` — the test citation form. */
const TEST_CITATION = /`([^`\n]*__tests__\/[^`\n]+\.test\.ts)`(?:\s*\("([^"]+)"\))?/g

/** An anchor as it appears in a comment, in any of the three comment syntaxes. */
const ANCHOR = /DESIGN:[ ]([a-z][a-z0-9-]*)/g

/**
 * Directories the anchor sweep does not enter. `docs/superpowers` and
 * `.superpowers` hold review specs, plans and task briefs that QUOTE anchors
 * while proposing them — working documents, not the library — so scanning them
 * would report every proposal as an unreferenced anchor. `__tests__` and
 * `tests` are excluded because anchors mark arguments in source; a test is
 * cited by name instead.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dts',
  'out',
  'coverage',
  '.git',
  '.changeset',
  '__tests__',
  'tests',
])
const SKIP_PATHS = ['docs/superpowers', '.superpowers', 'DESIGN.md']
const SCAN_EXT = ['.ts', '.md', '.mjs']

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const relPath = rel ? `${rel}/${entry}` : entry
    if (SKIP_PATHS.some((p) => relPath === p || relPath.startsWith(`${p}/`))) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      out.push(...walk(full, relPath))
      continue
    }
    if (SCAN_EXT.some((e) => entry.endsWith(e))) out.push(relPath)
  }
  return out.sort()
}

interface Citation {
  file: string
  slug: string
}

const citations: Citation[] = [...DESIGN.matchAll(CITATION)].map((m) => ({
  file: m[1],
  slug: m[2],
}))
const citedSlugs = new Set(citations.map((c) => c.slug))

function countAnchor(source: string, slug: string): number {
  const re = new RegExp(`DESIGN:[ ]${slug}(?![a-z0-9-])`, 'g')
  return [...source.matchAll(re)].length
}

describe('DESIGN.md citations resolve to anchors', () => {
  it('finds the citations it is supposed to be checking', () => {
    // Self-check: a scanner that silently matches nothing — someone reformats
    // the Where segments, the regex rots — would pass every assertion below
    // forever. The document carries ~34 refusals and ~60 anchored citations.
    expect(citations.length).toBeGreaterThan(50)
    expect(citedSlugs.has('stop-condition-not-a-predicate')).toBe(true)
    expect(citedSlugs.has('project-then-sanitize')).toBe(true)
  })

  it('no citation still carries a line number', () => {
    // The failure mode this whole test exists to end. A `path.ts:120-140`
    // inside a Where segment is a citation that will rot without saying so.
    const stale = [...DESIGN.matchAll(/`([^`\n]+\.(?:ts|md))(:\d+[-,\d\s]*)`/g)].map(
      (m) => m[1] + m[2],
    )
    expect(stale).toEqual([])
  })

  it('every cited anchor exists exactly once in the file it names', () => {
    const problems: string[] = []
    for (const { file, slug } of citations) {
      const full = join(ROOT, file)
      if (!existsSync(full)) {
        problems.push(`${file} (DESIGN: ${slug}) — no such file`)
        continue
      }
      const n = countAnchor(readFileSync(full, 'utf8'), slug)
      if (n !== 1) problems.push(`${file} (DESIGN: ${slug}) — found ${n}, want 1`)
    }
    // Listed rather than counted so a failure names what to fix. The fix is to
    // move the anchor with the argument, or to remove the citation with it.
    expect(problems).toEqual([])
  })

  it('every anchor in the tree is cited by DESIGN.md', () => {
    const orphans: string[] = []
    for (const file of walk(ROOT)) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const m of source.matchAll(ANCHOR)) {
        if (!citedSlugs.has(m[1])) orphans.push(`${file}: ${m[1]}`)
      }
    }
    // An anchor nobody cites is an argument whose entry was removed (delete the
    // anchor) or a citation someone forgot to write (add it to the Where).
    expect(orphans).toEqual([])
  })

  it('every cited test file exists, and its cited title is still there', () => {
    const problems: string[] = []
    for (const m of DESIGN.matchAll(TEST_CITATION)) {
      const [, file, title] = m
      const full = join(ROOT, file)
      if (!existsSync(full)) {
        problems.push(`${file} — no such file`)
        continue
      }
      if (title && !readFileSync(full, 'utf8').includes(title)) {
        problems.push(`${file} — no test titled "${title}"`)
      }
    }
    expect(problems).toEqual([])
  })
})
