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
// docs/plan.md is the second document this guards, on the same terms. It is
// the plan feature's living spec — DESIGN.md cites it and source cites it back
// — and it argued from ~160 line ranges, every one of which the move into
// @orchestral/plan and the edits since had already walked out from under. Same
// rot, one document over, so the same cure rather than a second one: a plan
// citation names a `DESIGN:` anchor exactly as a DESIGN.md citation does, the
// tree-wide sweep asks that an anchor be cited by SOME document, and one slug
// serves both when both documents argue from the same construct. A `PLAN:` tag
// would have been a second convention with its own sweep, and two tags on one
// argument are two things to keep in step.
//
// docs/plan.md also cites DESIGN.md itself, by ENTRY: `DESIGN.md, "We don't
// …"`. The heading is the handle there, exactly as a slug is here, and a
// renamed entry leaves the quote naming nothing just as quietly — so the last
// check holds every such quote to a heading DESIGN.md still has.
//
// Same move as error-code-convention.test.ts in @orchestral/runtime: turn a
// convention nothing enforces into a failing test rather than a habit.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../', import.meta.url).pathname

/** The documents whose citations this test holds to anchors. */
const DOCUMENTS = ['DESIGN.md', 'docs/plan.md'] as const
type DocumentPath = (typeof DOCUMENTS)[number]
const TEXT: Record<DocumentPath, string> = {
  'DESIGN.md': readFileSync(join(ROOT, 'DESIGN.md'), 'utf8'),
  'docs/plan.md': readFileSync(join(ROOT, 'docs/plan.md'), 'utf8'),
}

/** `` `path/to/file.ts` (DESIGN: some-slug) `` — the anchored citation form. */
const CITATION = /`([^`\n]+?)`\s*\(DESIGN:\s*([a-z][a-z0-9-]*)\)/g

/** `` `…/__tests__/foo.test.ts` ("an it title") `` — the test citation form. */
const TEST_CITATION = /`([^`\n]*__tests__\/[^`\n]+\.test\.ts)`(?:\s*\("([^"]+)"\))?/g

/** An anchor as it appears in a comment, in any of the three comment syntaxes. */
const ANCHOR = /DESIGN:[ ]([a-z][a-z0-9-]*)/g

/**
 * `DESIGN.md, "We don't …"` and `DESIGN.md's "We don't …"` — an entry cited by
 * its heading. The quote may wrap across a line, so its whitespace is folded
 * before it is looked up.
 */
const HEADING_CITATION = /DESIGN\.md(?:,|'s)\s+"([^"]+)"/g

/**
 * A line number riding on a citation, in every spelling the two documents have
 * used: `inline.ts:701-707` whether or not it sits in backticks (docs/plan.md
 * cites from inside its fenced code too), `DESIGN.md:327-343`, and the bare
 * `:379-381` / "doc at :80-96" that continues the file named just before it.
 * The last is the one a narrower pattern would miss, and it is exactly as stale.
 */
const LINE_NUMBER = /[\w./-]+\.(?:ts|mjs|md|json):\d+(?:[-,]\s?\d+)*|(?<=[\s(`]):\d+(?:[-,]\s?\d+)*(?=[`),.\s])/g

/**
 * Directories the anchor sweep does not enter. `docs/superpowers` and
 * `.superpowers` hold review specs, plans and task briefs that QUOTE anchors
 * while proposing them — working documents, not the library — so scanning them
 * would report every proposal as an unreferenced anchor. `__tests__` and
 * `tests` are excluded because anchors mark arguments in source; a test is
 * cited by name instead.
 *
 * `.claude` is this repository's own defect, not the library's: agent worktrees
 * are checked out under `.claude/worktrees/<branch>/`, so a sweep from the root
 * of a checkout that has one walks a whole second copy of the tree and reports
 * every anchor in it as living in a file DESIGN.md does not cite. The citations
 * are about THIS working tree; another branch's copy of it is not evidence.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dts',
  'out',
  'coverage',
  '.git',
  '.changeset',
  '.claude',
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

function citationsIn(doc: DocumentPath): Citation[] {
  return [...TEXT[doc].matchAll(CITATION)].map((m) => ({ file: m[1], slug: m[2] }))
}

/** Every slug SOME document cites — what the orphan sweep answers to. */
const citedSlugs = new Set(DOCUMENTS.flatMap((doc) => citationsIn(doc).map((c) => c.slug)))

/**
 * A file's text as the anchor checks read it. docs/plan.md both carries an
 * anchor (DESIGN.md cites it) and cites anchors, and each of its citations
 * spells `DESIGN: <slug>` — read raw, every plan citation would count as an
 * anchor planted in the document doing the citing, and so as its own proof.
 */
function anchorSource(file: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8')
  return (DOCUMENTS as readonly string[]).includes(file) ? text.replace(CITATION, '') : text
}

function countAnchor(source: string, slug: string): number {
  const re = new RegExp(`DESIGN:[ ]${slug}(?![a-z0-9-])`, 'g')
  return [...source.matchAll(re)].length
}

/**
 * The floor under each document's citation count, and two slugs it must find.
 * Self-check: a scanner that silently matches nothing — someone reformats the
 * Where segments, the regex rots — would pass every other assertion forever.
 * DESIGN.md carries ~34 refusals and ~60 anchored citations; docs/plan.md
 * argues nearly every sentence of its execution model from a citation.
 */
const EXPECTED: Record<DocumentPath, { atLeast: number; slugs: readonly string[] }> = {
  'DESIGN.md': {
    atLeast: 50,
    slugs: ['stop-condition-not-a-predicate', 'project-then-sanitize'],
  },
  'docs/plan.md': {
    atLeast: 100,
    slugs: ['default-step-id-is-positional', 'submit-registry-lookup'],
  },
}

describe.each(DOCUMENTS)('%s citations resolve to anchors', (doc) => {
  const text = TEXT[doc]
  const citations = citationsIn(doc)

  it('finds the citations it is supposed to be checking', () => {
    expect(citations.length).toBeGreaterThan(EXPECTED[doc].atLeast)
    const slugs = new Set(citations.map((c) => c.slug))
    for (const slug of EXPECTED[doc].slugs) expect(slugs.has(slug)).toBe(true)
  })

  it('no citation still carries a line number', () => {
    // The failure mode this whole test exists to end. A `path.ts:120-140`
    // inside a Where segment is a citation that will rot without saying so.
    const stale = [...text.matchAll(LINE_NUMBER)].map((m) => m[0])
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
      const n = countAnchor(anchorSource(file), slug)
      if (n !== 1) problems.push(`${file} (DESIGN: ${slug}) — found ${n}, want 1`)
    }
    // Listed rather than counted so a failure names what to fix. The fix is to
    // move the anchor with the argument, or to remove the citation with it.
    expect(problems).toEqual([])
  })

  it('every cited test file exists, and its cited title is still there', () => {
    const problems: string[] = []
    for (const m of text.matchAll(TEST_CITATION)) {
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

describe('the anchors in the tree', () => {
  it('every anchor is cited by DESIGN.md or docs/plan.md', () => {
    const orphans: string[] = []
    for (const file of walk(ROOT)) {
      for (const m of anchorSource(file).matchAll(ANCHOR)) {
        if (!citedSlugs.has(m[1])) orphans.push(`${file}: ${m[1]}`)
      }
    }
    // An anchor nobody cites is an argument whose entry was removed (delete the
    // anchor) or a citation someone forgot to write (add it to the Where).
    expect(orphans).toEqual([])
  })
})

describe('docs/plan.md citations of DESIGN.md entries', () => {
  it('every entry it quotes by heading is a heading DESIGN.md still has', () => {
    const headings = new Set(
      [...TEXT['DESIGN.md'].matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].trim()),
    )
    const quoted = [...TEXT['docs/plan.md'].matchAll(HEADING_CITATION)].map((m) =>
      m[1].replace(/\s+/g, ' '),
    )
    // Self-check, as for the anchors: fourteen today, and a pattern that
    // stopped matching would otherwise pass on an empty list.
    expect(quoted.length).toBeGreaterThan(10)
    expect(quoted.filter((heading) => !headings.has(heading))).toEqual([])
  })
})
