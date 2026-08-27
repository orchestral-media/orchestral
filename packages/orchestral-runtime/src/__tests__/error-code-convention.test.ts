// Source-level drift guard for the runtime's error-code convention.
//
// The convention: when a thrown Error's message opens with a screaming-snake
// code (`AGENT_INCOMPLETE: …`), that same code must also be attached as an
// `Error.code` property, because `normaliseError` reads `.code` and nothing
// else. A throw that only *says* its code in prose normalises to the generic
// `DISPATCH_EXECUTE_FAILED`, and the host is left regexing message text to
// tell a depth-limit rejection from a provider blowup.
//
// Nothing in the type system enforces this — `throw new Error(...)` compiles
// exactly as well without the property — so the convention held only as long
// as every author remembered it, and `AGENT_DEPTH_EXCEEDED` is the one that
// did not. A static scan turns "remember to" into a failing test: the same
// move as the export snapshot in public-surface.test.ts, applied to a
// convention instead of a surface.
//
// Scope is this package's `src` (tests excluded). Sibling packages have their
// own error vocabularies and mostly return structured results rather than
// throwing; extending the scan there is a separate decision, not an oversight.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../', import.meta.url).pathname

/**
 * Known-good exceptions, keyed by `file:CODE`. Empty on purpose: every site
 * the scan finds today attaches its code. An entry here is a claim that the
 * code genuinely must not reach `JobError` — add one with the reason inline,
 * not to quiet a failure.
 */
const EXEMPT: ReadonlySet<string> = new Set<string>()

/**
 * A code-shaped message: `SOME_CODE:` at the start of the literal, or a
 * literal that is nothing BUT the code. The second shape is the hole the first
 * scan left open — `new Error('CANCELLED')` says its code and attaches
 * nothing, and CANCELLED is the one code the agent loop reads to decide
 * whether an abort ends the run.
 */
const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,})(?::|$)/

interface Finding {
  file: string
  line: number
  code: string
  attached: boolean
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...tsFiles(full))
      continue
    }
    if (entry.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

/** End index (exclusive) of the parenthesised argument list opened at `open`. */
function matchParen(src: string, open: number): number {
  let depth = 1
  let i = open
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return i
}

/**
 * The leading *literal* text of an argument, or null when the argument does
 * not start with a string/template literal. Stops at the first interpolation
 * so `` `CODE: ${id}` `` yields `CODE: `.
 */
function leadingLiteral(arg: string): string | null {
  const a = arg.trimStart()
  const quote = a[0]
  if (quote !== '`' && quote !== "'" && quote !== '"') return null
  const rest = a.slice(1)
  const stops = [rest.indexOf(quote), quote === '`' ? rest.indexOf('${') : -1].filter(
    (i) => i >= 0,
  )
  return stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest
}

function scan(src: string, file: string): Finding[] {
  const found: Finding[] = []
  for (const m of src.matchAll(/new Error\(/g)) {
    const open = m.index + m[0].length
    const close = matchParen(src, open)
    const literal = leadingLiteral(src.slice(open, close - 1))
    if (literal === null) continue
    const code = CODE_PREFIX.exec(literal)?.[1]
    if (!code) continue
    // Two accepted spellings of "the code is attached", both present in the
    // codebase: the wrapper immediately preceding the construction, and the
    // property literal that follows it. Requiring the code to MATCH the
    // message prefix is the point — a copy-pasted `Object.assign` carrying the
    // neighbouring site's code is exactly the drift this catches.
    const before = src.slice(0, m.index).trimEnd()
    const after = src.slice(close, close + 240)
    const attached =
      before.endsWith('Object.assign(') &&
      new RegExp(`code:\\s*['"\`]${code}['"\`]`).test(after)
    found.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      code,
      attached,
    })
  }
  return found
}

describe('runtime error-code convention', () => {
  const findings = tsFiles(SRC).flatMap((f) =>
    scan(readFileSync(f, 'utf8'), f.slice(SRC.length)),
  )

  it('finds the coded throws it is supposed to be checking', () => {
    // Self-check: a scanner that silently matches nothing — a refactor moves
    // the files, the regex rots — would pass the assertion below forever.
    expect(findings.length).toBeGreaterThan(15)
    expect(findings.map((f) => f.code)).toContain('AGENT_DEPTH_EXCEEDED')
    expect(findings.map((f) => f.code)).toContain('OUTPUT_SCHEMA_MISMATCH')
  })

  it('every code-prefixed throw carries a matching Error.code', () => {
    const violations = findings
      .filter((f) => !f.attached)
      .map((f) => `${f.file}:${f.line} ${f.code}`)
      .filter((v) => !EXEMPT.has(v.replace(/:\d+ /, ':')))
    // Listed rather than counted so a failure names the file and line to fix.
    // The fix is `throw Object.assign(new Error(msg), { code: 'THE_CODE' })`;
    // the alternative is an EXEMPT entry with a reason.
    expect(violations).toEqual([])
  })
})
