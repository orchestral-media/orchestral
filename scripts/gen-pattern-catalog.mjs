// Generate the Pattern catalog table in packages/orchestral-patterns/README.md.
//
// Prerequisite: a built tree. This script reads the *published* artifacts —
// `packages/orchestral-{core,patterns}/dist/index.js` for runtime values and
// `packages/orchestral-patterns/dist/index.d.ts` for the type-level host-op
// declarations — so the table documents what consumers actually install, not
// what happens to be in src. Build first:
//
//   pnpm -r --filter "./packages/orchestral-*" build
//   node scripts/gen-pattern-catalog.mjs      # or: pnpm docs:catalog
//
// Everything in the table is derived, nothing hand-maintained. Each column and
// where it comes from:
//
//   id / kind / purpose  — the Pattern instance returned by its factory
//   input slots          — Pattern.assetNeeds
//   output               — the outputs ZodObject's `modality` literal and
//                          whether it declares an `assets` field (the same two
//                          signals core's find_pattern projects for the LLM)
//   host prerequisites   — `Pick<MetaCommonDeps, ...>` on the factory's deps
//                          parameter, read out of dist/index.d.ts. The op names
//                          exist only in the type system, so there is no
//                          runtime value to read; parsing the emitted .d.ts is
//                          the closest thing to reading the type checker's own
//                          output, and it exits non-zero on anything it can't
//                          parse (see hostOpsFor) rather than going stale the way a
//                          hand-maintained table would.
//   alternatives         — registry attachments after registration, which is
//                          where a factory's default-mounted alternatives land

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

const distUrl = (dir, file = 'index.js') =>
  new URL(`../packages/${dir}/dist/${file}`, import.meta.url)

const README_URL = new URL('../packages/orchestral-patterns/README.md', import.meta.url)
const START = '<!-- catalog:start -->'
const END = '<!-- catalog:end -->'

const required = [
  ['@orchestral/core', distUrl('orchestral-core')],
  ['@orchestral/patterns', distUrl('orchestral-patterns')],
  ['@orchestral/patterns (types)', distUrl('orchestral-patterns', 'index.d.ts')],
]
const missing = required.filter(([, url]) => !existsSync(url))
if (missing.length > 0) {
  console.error('docs:catalog — missing build artifacts:\n')
  for (const [name, url] of missing) {
    console.error(`  ✗ ${name}: ${fileURLToPath(url)} not found`)
  }
  console.error(
    '\nThis script reads the built dist, not src. Build first, then re-run:\n' +
      '  pnpm -r --filter "./packages/orchestral-*" build\n' +
      '  node scripts/gen-pattern-catalog.mjs\n',
  )
  process.exit(1)
}

// patterns' dist externalizes `@orchestral/core` as a bare specifier, which in
// this workspace resolves to core's src/index.ts (unrunnable TS). Same resolve
// hook as scripts/smoke-dist.mjs: point it at core's dist instead.
const hookSource = `
const MAP = ${JSON.stringify({ '@orchestral/core': distUrl('orchestral-core').href })}
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(MAP, specifier)) return { url: MAP[specifier], shortCircuit: true }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url)

const { PatternRegistry } = await import(distUrl('orchestral-core').href)
const patterns = await import(distUrl('orchestral-patterns').href)

// ── host-op prerequisites, read off the emitted .d.ts ──────────────────────

const dts = readFileSync(distUrl('orchestral-patterns', 'index.d.ts'), 'utf8')

/** `export declare type XMetaDeps = Pick<MetaCommonDeps, 'a' | 'b'> & {...}` */
const depsTypeToOps = new Map()
for (const m of dts.matchAll(
  /export declare type (\w+)\s*=\s*Pick<\s*MetaCommonDeps\s*,\s*([^>]*)>/g,
)) {
  const ops = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
  depsTypeToOps.set(m[1], ops)
}

// `export declare function createXMeta(deps: XMetaDeps): MetaPattern<…>` — the
// param list, taken up to the `): <Kind>Pattern<` return type so an inline
// object-literal parameter (which contains its own braces) survives the match.
const factoryToParams = new Map()
for (const m of dts.matchAll(
  /export declare function (create\w+)\(([\s\S]*?)\):\s*(?:Atomic|Meta|Agent)Pattern</g,
)) {
  factoryToParams.set(m[1], m[2].trim())
}

/** The emitted declaration of `type`, trimmed for use in an error message. */
function declarationOf(type) {
  const m = new RegExp(
    `export declare (?:type|interface) ${type}\\b[\\s\\S]*?(?=\\nexport declare |$)`,
  ).exec(dts)
  return m === null ? null : m[0].trim().slice(0, 400)
}

/**
 * Ops the factory's deps parameter asks of the host, or `{ error }` when the
 * emitted shape can't be parsed. Every "we saw MetaCommonDeps but came away
 * with nothing" case is an error rather than an empty cell: an op list that
 * silently empties out reads in the table exactly like a factory that needs no
 * host support, which is the one mistake this table exists to prevent.
 */
function hostOpsFor(factoryName) {
  const params = factoryToParams.get(factoryName)
  if (params === undefined) {
    return { error: 'no matching factory declaration in the emitted .d.ts' }
  }
  if (params === '') return [] // nullary factory — nothing for the host to supply
  const named = /^\w+\??:\s*(\w+)$/.exec(params)
  if (named === null) {
    // An inline object-literal parameter — alternatives-only init sugar, never
    // a MetaCommonDeps Pick (which is always a named exported type). Anything
    // else means the emitted shape moved and this parse can't be trusted.
    if (/^\w+\??:\s*\{[\s\S]*\}$/.test(params)) return []
    return { error: `unparseable deps parameter: ${params}` }
  }
  const type = named[1]
  if (depsTypeToOps.has(type)) {
    const ops = depsTypeToOps.get(type)
    if (ops.length > 0) return ops
    return {
      error:
        `${type} is a Pick<MetaCommonDeps, …> but no op names came out of it:\n    ` +
        (declarationOf(type) ?? '(declaration not found)'),
    }
  }
  const declaration = declarationOf(type)
  if (declaration === null) {
    return { error: `deps type ${type} has no declaration in the emitted .d.ts` }
  }
  if (declaration.includes('MetaCommonDeps')) {
    return {
      error:
        `${type} references MetaCommonDeps but did not parse as ` +
        `Pick<MetaCommonDeps, …>:\n    ${declaration}`,
    }
  }
  // A declared type that isn't a MetaCommonDeps Pick — an init bag of prompt
  // overrides, which asks nothing of the host.
  return []
}

// ── instantiate + register every factory ──────────────────────────────────

const factoryNames = Object.keys(patterns)
  .filter((k) => /^create[A-Z]/.test(k) && typeof patterns[k] === 'function')
  .sort()

const registry = new PatternRegistry()
const rows = []

// register() audits every outputs schema and warns about unbounded fields.
// The shipped catalog is bounded end to end (a test in @orchestral/patterns
// pins zero warnings), so nothing is muted here: a line above the table means
// a pattern regressed, and the generated README should not hide it.
for (const name of factoryNames) {
  // Every factory's parameter is optional-by-use at construction time: deps
  // ops are only invoked inside compose(), never while building the Pattern.
  const pattern = patterns[name]({})
  registry.register(pattern)
  rows.push({ name, id: pattern.id })
}

// ── column formatters ─────────────────────────────────────────────────────

const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ')

function toolDescriptionOf(pattern) {
  return pattern.tool?.description ?? pattern.primary?.tool?.description ?? ''
}

/** First sentence, capped at ~100 chars on a word boundary. */
function firstSentence(text) {
  const stop = text.search(/\.(\s|$)/)
  let s = (stop === -1 ? text : text.slice(0, stop + 1)).trim()
  if (s.length > 100) {
    const cut = s.lastIndexOf(' ', 100)
    s = `${s.slice(0, cut === -1 ? 100 : cut).trimEnd()}…`
  }
  return s
}

function slotsOf(pattern) {
  const needs = pattern.assetNeeds ?? []
  if (needs.length === 0) return '—'
  return needs
    .map((n) => `\`${n.slot}\`:${n.modality}${n.cardinality === 'array' ? '[]' : ''}${n.required ? ' **req**' : ''}`)
    .join('<br>')
}

/**
 * Same two signals core's find_pattern projects for the LLM: the `modality`
 * literal, and whether the shape declares an `assets` field.
 */
function outputOf(pattern) {
  const shape = pattern.outputs?.shape
  if (!shape) return '—'
  const def = shape.modality?._def
  const modality =
    def?.type === 'literal' && Array.isArray(def.values) ? def.values[0] : undefined
  const parts = [modality, shape.assets !== undefined ? 'assets[]' : undefined].filter(
    (p) => p !== undefined,
  )
  return parts.length === 0 ? '—' : parts.join(', ')
}

function alternativesOf(id) {
  const alts = registry.getEntry(id)?.alternatives ?? []
  if (alts.length === 0) return '—'
  return alts.map((a) => `→ \`${a.via.patternId}\``).join('<br>')
}

// ── render ────────────────────────────────────────────────────────────────

const header = [
  '| Pattern | Kind | What it does | Input slots | Output | Host ops required | Alternatives |',
  '| --- | --- | --- | --- | --- | --- | --- |',
]

const body = rows
  .sort((a, b) => {
    const ka = registry.getEntry(a.id).pattern.kind
    const kb = registry.getEntry(b.id).pattern.kind
    const order = { atomic: 0, meta: 1, agent: 2 }
    return order[ka] - order[kb] || a.id.localeCompare(b.id)
  })
  .map(({ name, id }) => {
    const pattern = registry.getEntry(id).pattern
    const ops = hostOpsFor(name)
    if (!Array.isArray(ops)) {
      console.error(
        `docs:catalog — could not resolve the host ops for ${name}() (\`${id}\`):\n` +
          `  ${ops.error}\n` +
          '  The .d.ts shape changed; fix the parser in this script.',
      )
      process.exit(1)
    }
    const opsCell = ops.length === 0 ? '—' : ops.map((o) => `\`${o}\``).join('<br>')
    return `| \`${id}\` | ${pattern.kind} | ${cell(firstSentence(toolDescriptionOf(pattern)))} | ${slotsOf(pattern)} | ${outputOf(pattern)} | ${opsCell} | ${alternativesOf(id)} |`
  })

const table = [
  `<!-- Generated by scripts/gen-pattern-catalog.mjs — run \`pnpm docs:catalog\` after changing a Pattern. Do not edit by hand. -->`,
  '',
  ...header,
  ...body,
  '',
  `${rows.length} Patterns.`,
  '',
  '- **Input slots** — the `assetNeeds` an author declared; the LLM fills them through `input.references.<slot>`. `[]` marks a multi-asset slot, **req** a required one. A Pattern with no slots takes text input only.',
  '- **Output** — the same projection `find_pattern` shows the LLM: the outputs schema\'s `modality` literal, and `assets[]` when it returns produced assets. Every shipped meta that produces media returns it through `assets[]` (with a role `label` per element); a pattern that produces no media reads as `—` here.',
  "- **Host ops required** — the `MetaCommonDeps` operations the factory takes as constructor deps. This package specifies them but does not implement them, so the host must (see [Deliverable metas](#deliverable-metas)).",
  '- **Alternatives** — fallback paths the factory mounts by default; the runtime cascades to them when the primary path is unsatisfiable or fails.',
].join('\n')

const readme = readFileSync(README_URL, 'utf8')
const from = readme.indexOf(START)
const to = readme.indexOf(END)
if (from === -1 || to === -1) {
  console.error(
    `docs:catalog — anchors ${START} / ${END} not found in ${fileURLToPath(README_URL)}.`,
  )
  process.exit(1)
}
const next = `${readme.slice(0, from + START.length)}\n${table}\n${readme.slice(to)}`
writeFileSync(README_URL, next)

console.log(`docs:catalog — wrote ${rows.length} Patterns to packages/orchestral-patterns/README.md`)
