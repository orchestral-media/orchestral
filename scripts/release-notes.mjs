// The release notes for one version of the line, assembled out of the
// CHANGELOG sections `changeset version` already wrote.
//
// Why not the changesets action's own release step: it derives what shipped by
// parsing `changeset publish` stdout, which `pnpm -r publish` does not emit —
// the reason `create-github-releases: false` is set in release.yml. The tag and
// the CHANGELOGs are what a publish leaves behind whatever the publisher
// printed, so the release is built from those instead. PUBLISH.md §5 assembled
// them by hand at 0.1.0 ("Notes are assembled by hand from the seven
// CHANGELOG.md files"); this is that, without the hand.
//
// Neither obvious shortcut works, and this repo's own history is why:
//
//   • Read core alone → nothing to say for a version whose changeset did not
//     name core. That is 0.2.0: core's section is the heading and nothing else
//     while patterns, agent, runtime, discovery and adapters carry the news.
//   • Concatenate all seven → `changeset version` copies a summary into every
//     package the changeset named, so 0.3.0 would publish one ~300-line essay
//     seven times over.
//
// What is actually wanted is the set of changeset summaries in this version, so
// that is what this builds: the distinct entries across the published packages,
// grouped under the heading each was written under, with the `Updated
// dependencies` bookkeeping dropped — every one of those names packages that
// are in this same release, so on a release page it is noise.
//
// Usage: `node scripts/release-notes.mjs <version>` — prints the body to
// stdout, or exits 1 naming what it could not find.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The body under `## <version>`, up to the next `## ` heading.
 *
 * Null rather than an empty string when the section is absent or blank: a
 * caller must be able to tell "nothing to say" from "nothing found", and core's
 * `## 0.2.0` is a real instance of the first.
 */
export function versionSection(changelog, version) {
  const lines = changelog.split('\n')
  // Exact match on the heading text, not a prefix: `0.4.0` must not select
  // `## 0.4.0-rc.1`, whose notes are not this release's.
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) return null

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return body === '' ? null : body
}

/**
 * The `- ` entries of one section, each tagged with the `### ` heading it sits
 * under. Continuation lines (the indented paragraphs of a long summary) stay
 * with their entry.
 */
function entriesOf(section) {
  const entries = []
  let heading = ''
  let current = null

  for (const line of section.split('\n')) {
    if (line.startsWith('### ')) {
      heading = line.slice(4).trim()
      current = null
      continue
    }
    if (line.startsWith('- ')) {
      current = { heading, lines: [line] }
      entries.push(current)
      continue
    }
    // Blank lines and indented continuations belong to the open entry; a blank
    // line before the first entry belongs to nothing.
    if (current !== null) current.lines.push(line)
  }

  return entries.map((entry) => ({ heading: entry.heading, text: entry.lines.join('\n').trim() }))
}

// `- Updated dependencies [sha]` plus the indented list under it. Written by
// `changeset version` for a package that only moved because something it
// depends on did.
const BOOKKEEPING = /^-\s+Updated dependencies\b/

/**
 * The release body for one version: every distinct changeset summary across the
 * given CHANGELOGs, under the heading it was written under.
 *
 * Null when no package has a summary for that version — an empty body would
 * publish a release that says nothing about a version already on the registry.
 */
export function releaseNotes(changelogs, version) {
  /** @type {Map<string, string[]>} */
  const byHeading = new Map()
  const seen = new Set()

  for (const changelog of changelogs) {
    const section = versionSection(changelog, version)
    if (section === null) continue

    for (const { heading, text } of entriesOf(section)) {
      if (BOOKKEEPING.test(text)) continue
      // The same summary is copied verbatim into every package the changeset
      // named, so identical text is one piece of news, not several.
      const key = text.replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)

      const bucket = byHeading.get(heading)
      if (bucket === undefined) byHeading.set(heading, [text])
      else bucket.push(text)
    }
  }

  if (byHeading.size === 0) return null

  return [...byHeading]
    .map(([heading, texts]) => `### ${heading}\n\n${texts.join('\n\n')}`)
    .join('\n\n')
}

/**
 * Every published package's CHANGELOG, newest-first by nothing in particular —
 * order only decides which copy of a duplicated summary is quoted, and they are
 * identical by construction.
 *
 * Derived from `private` in each package.json rather than a list kept here:
 * @orchestral/dsh-plugin is out because it says it is out, so a package joining
 * or leaving the line needs no edit in this file.
 */
export function publishedChangelogs(root) {
  return readdirSync(join(root, 'packages'))
    .map((dir) => join(root, 'packages', dir))
    .filter((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).private !== true)
    .map((dir) => ({
      name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name,
      changelog: readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'),
    }))
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const version = process.argv[2]
  if (version === undefined) {
    console.error('usage: node scripts/release-notes.mjs <version>')
    process.exit(1)
  }

  const packages = publishedChangelogs(process.cwd())
  const notes = releaseNotes(
    packages.map((pkg) => pkg.changelog),
    version,
  )
  if (notes === null) {
    // Loud, because the alternative is a silent empty release. By the time this
    // runs the packages are published and the tag is cut, so a human reading
    // this line can write the notes by hand — the next push finds the release
    // present and skips.
    console.error(
      `no changeset summary for ${version} in any of: ${packages.map((p) => p.name).join(', ')}`,
    )
    process.exit(1)
  }

  process.stdout.write(`${notes}\n`)
}
