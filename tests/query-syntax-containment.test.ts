// Repo-level guard: retrieval's query mini-language stays inside the package
// that parses it.
//
// `select:<id>`, `+term` and `namespace:<ns>` are @orchestral/discovery's
// syntax — its `parseSelector` is the only thing in the tree that reads them,
// and `QUERY_SYNTAX_HINT` is the only string that should teach them. Every
// other package reaches retrieval through core's `PatternSearch` seam and
// cannot know which implementation a host wired: a `describe` in
// @orchestral/plan that tells the model to write `select:text-to-image` is a
// promise about a parser its own package does not depend on, and it is wrong
// for every host that swapped discovery out or wired no search at all.
//
// This is the systematic half of that fix. Rewording the two strings that said
// it fixes today; a sweep is what stops the third one, because the drift is
// invisible — the string still reads fine, it is only false on somebody else's
// deployment.
//
// Scope: string literals in `packages/*/src`, which is where a model-visible
// string lives. Comments are skipped (a comment describing the syntax is
// documentation, not an instruction to a model) and so are `__tests__` (a test
// may legitimately feed `select:…` to the parser as INPUT).
//
// Calibrated against the real tree before it was written: the three token
// regexes below hit exactly the four QUERY_SYNTAX_HINT / diagnostic strings
// inside @orchestral/discovery and nothing else. Two near-misses are the
// reason each regex is shaped the way it is, and both must keep passing:
//   • `FindPatternInputSchema.query`'s "grouped by namespace: image-gen / …"
//     is English prose, not a selector — hence `namespace:` must be followed
//     by a non-space.
//   • `find_pattern`'s "a compact output summary (modality + producesAssets)"
//     is a sum, not a mandatory-term operator — hence `+` must be followed
//     immediately by a letter.
// The `<prefix>*` wildcard is deliberately NOT swept: `meta_*` / `agent_*`
// appear in @orchestral/plan as ordinary id-prefix prose ("call a meta_*
// pattern"), which claims nothing about anyone's query parser, so a regex for
// it would report noise instead of drift.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')

/** The package that owns the syntax, and is therefore the one place it may appear. */
const OWNER = '@orchestral/discovery'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dts', 'temp', 'etc', '__tests__'])

const QUERY_SYNTAX_TOKENS: readonly (readonly [string, RegExp])[] = [
  ['select:<id>', /select:\S/],
  ['namespace:<ns>', /namespace:\S/],
  ['+term', /(^|[\s"'([])\+[A-Za-z]/],
]

function walkTs(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const relPath = rel ? `${rel}/${entry}` : entry
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      out.push(...walkTs(full, relPath))
      continue
    }
    if (entry.endsWith('.ts')) out.push(relPath)
  }
  return out.sort()
}

/**
 * Every string literal in a TS source, with comments skipped — a lexical
 * approximation, not a parser. It tracks the three quote forms and both
 * comment forms, which is enough to tell "text an LLM will read" from "a
 * sentence explaining that text to a human". A construct it mis-lexes can only
 * make the sweep louder (a swallowed tail reported as one long literal), never
 * quieter, so a mistake here shows up as a failing test rather than a hole.
 */
function stringLiterals(src: string): string[] {
  const out: string[] = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      let buf = ''
      while (i < n) {
        if (src[i] === '\\') {
          buf += src[i + 1] ?? ''
          i += 2
          continue
        }
        if (src[i] === quote) {
          i++
          break
        }
        // An unterminated single/double quote is a lexing mistake, not a
        // literal — stop at the newline rather than swallowing the file.
        if (quote !== '`' && src[i] === '\n') break
        buf += src[i]
        i++
      }
      out.push(buf)
      continue
    }
    i++
  }
  return out
}

interface Hit {
  where: string
  token: string
  text: string
}

function sweep(): { hits: Hit[]; ownerHits: Hit[]; filesScanned: number } {
  const hits: Hit[] = []
  const ownerHits: Hit[] = []
  let filesScanned = 0
  for (const pkgDir of readdirSync(PACKAGES)) {
    const srcDir = join(PACKAGES, pkgDir, 'src')
    if (!statSync(join(PACKAGES, pkgDir)).isDirectory()) continue
    let files: string[]
    try {
      files = walkTs(srcDir)
    } catch {
      continue
    }
    const name = (
      JSON.parse(readFileSync(join(PACKAGES, pkgDir, 'package.json'), 'utf8')) as {
        name: string
      }
    ).name
    for (const file of files) {
      filesScanned++
      const src = readFileSync(join(srcDir, file), 'utf8')
      for (const literal of stringLiterals(src)) {
        for (const [token, re] of QUERY_SYNTAX_TOKENS) {
          if (!re.test(literal)) continue
          const hit: Hit = {
            where: `${name} ${file}`,
            token,
            text: literal.slice(0, 120).replace(/\s+/g, ' '),
          }
          if (name === OWNER) ownerHits.push(hit)
          else hits.push(hit)
        }
      }
    }
  }
  return { hits, ownerHits, filesScanned }
}

describe("retrieval's query syntax stays in the package that parses it", () => {
  const { hits, ownerHits, filesScanned } = sweep()

  it('appears in no model-visible string outside @orchestral/discovery', () => {
    expect(
      hits.map((h) => `${h.where}: ${h.token} in "${h.text}"`),
      'a package that does not parse this syntax is teaching it to a model',
    ).toEqual([])
  })

  it('still finds it inside @orchestral/discovery, so the sweep is known to bite', () => {
    // Without this the previous assertion passes just as well on a broken
    // walker, a wrong root, or a regex that matches nothing.
    expect(filesScanned).toBeGreaterThan(50)
    expect(ownerHits.length).toBeGreaterThan(0)
    expect(new Set(ownerHits.map((h) => h.token))).toEqual(
      new Set(QUERY_SYNTAX_TOKENS.map(([token]) => token)),
    )
  })
})
