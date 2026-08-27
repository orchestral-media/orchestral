// Source-level drift guard: the zod serialiser has exactly one call site.
//
// Byte-stable JSON Schema is a cross-package invariant — the always-load tool
// prefix is a KV-cache key, and two surfaces rendering the same Pattern must
// render the same bytes. The invariant is carried entirely by one argument
// (`{ target: 'draft-2020-12' }`) that no type checks: a call site that omits
// it, or adds `io: 'output'`, compiles fine and forks the bytes silently.
// Four such copies existed (catalog-builder, find-pattern, meta-utils, the dsh
// bridge) and agreed only by luck — each was written knowingly, with its own
// explanatory comment, which is exactly why review never caught the fork risk.
//
// So the rule is positional and this test is its only enforcement: `z.toJSONSchema`
// is called in `schema.ts` and nowhere else under `packages/*/src`. Everyone
// else calls `toJsonSchema`.
//
// Lives in core because core owns that one call site, and because core's suite
// already reads sibling packages off disk (manifest.test.ts). `__tests__` is
// out of scope: a test asserting on raw zod output is asserting about zod, not
// about this invariant.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** `packages/` — this file sits at `packages/orchestral-core/src/__tests__/`. */
const PACKAGES = new URL('../../../', import.meta.url).pathname

/** The one file allowed to call it, spelled `<package>/src/<path>`. */
const SOLE_CALL_SITE = 'orchestral-core/src/schema.ts'

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

function packageSourceFiles(): string[] {
  const out: string[] = []
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const src = join(PACKAGES, pkg, 'src')
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    out.push(...tsFiles(src))
  }
  return out
}

/**
 * Comments removed, so the prose that NAMES the serialiser (plan.ts,
 * extend-inputs-with-references.ts, and the pointers this refactor leaves
 * behind) is not read as a call. Crude on purpose: it can also eat a `//`
 * inside a string literal, which cannot manufacture a false positive — and a
 * stripper that ate real code would drop `schema.ts` from the results, which
 * the self-check below turns into a failure rather than a silent pass.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('z.toJSONSchema has a single call site', () => {
  const files = packageSourceFiles()
  const callers = files
    .filter((f) => /z\.toJSONSchema\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(PACKAGES.length))

  it('actually scanned the package sources', () => {
    // A scanner that quietly matches nothing — a moved directory, a rotted
    // regex, an over-eager comment stripper — would pass the assertion below
    // forever.
    expect(files.length).toBeGreaterThan(80)
    expect(callers).toContain(SOLE_CALL_SITE)
  })

  it('is called only by the core toJsonSchema wrapper', () => {
    // Listed rather than counted so a failure names the file to fix. The fix is
    // `toJsonSchema(schema)` from @orchestral/core, never a second
    // `z.toJSONSchema(..., { target: 'draft-2020-12' })`.
    expect(callers).toEqual([SOLE_CALL_SITE])
  })
})
