// Guard for the notes the Release workflow attaches to a GitHub release.
//
// A publish leaves two things behind that are true no matter what the publisher
// printed: the `v<version>` tag, and the CHANGELOG sections `changeset version`
// wrote for that version. The release is built from those, which is why
// `create-github-releases: false` stays set on the changesets action — its own
// release step derives what shipped by parsing `changeset publish` stdout, and
// `pnpm -r publish` does not emit it.
//
// The shape being parsed, and why neither obvious shortcut works — both mistakes
// are in this repo's own history:
//   • `changeset version` copies a changeset's summary into EVERY package the
//     changeset named, so 0.3.0 carries one ~300-line essay seven times over.
//     Concatenating the packages would publish it seven times.
//   • A changeset that does not name core leaves core's section empty while the
//     line really did change — 0.2.0, where the summaries went to patterns,
//     agent, runtime, discovery and adapters. Reading core alone would publish
//     nothing for it.
// So the body is the DISTINCT summaries across the published packages, with the
// `Updated dependencies` bookkeeping dropped: every one of those names packages
// that are in this same release, so it is noise on the release page.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { publishedChangelogs, releaseNotes, versionSection } from '../scripts/release-notes.mjs'

const ROOT = new URL('../', import.meta.url).pathname

const CORE = `# Changelog

## 0.4.0

### Minor Changes

- abc1234: The summary someone wrote.

  A second paragraph of it.

## 0.3.0

### Minor Changes

- def5678: An older summary.
`

// Same changeset, copied here by \`changeset version\` because it named this
// package too — plus the dependency bump it did not write by hand.
const RUNTIME = `# Changelog

## 0.4.0

### Minor Changes

- abc1234: The summary someone wrote.

  A second paragraph of it.

### Patch Changes

- Updated dependencies [abc1234]
  - @orchestral/core@0.4.0

## 0.3.0
`

const PATTERNS = `# Changelog

## 0.4.0

### Patch Changes

- Updated dependencies [abc1234]
  - @orchestral/core@0.4.0
`

describe('versionSection', () => {
  it('takes the body of one version, stopping at the next version heading', () => {
    expect(versionSection(CORE, '0.3.0')).toBe(
      ['### Minor Changes', '', '- def5678: An older summary.'].join('\n'),
    )
    // Quoting the next version's notes is the mistake that reads as correct.
    expect(versionSection(CORE, '0.4.0')).not.toContain('An older summary')
  })

  it('returns null for a version the file does not carry or leaves empty', () => {
    expect(versionSection(CORE, '9.9.9')).toBeNull()
    expect(versionSection(CORE, '0.4')).toBeNull()
    // 0.2.0's real shape in core: the heading with nothing under it.
    expect(versionSection('## 0.2.0\n\n## 0.1.0\n\nnotes\n', '0.2.0')).toBeNull()
  })

  it('does not mistake a version that is a prefix of another for it', () => {
    const ambiguous = '## 0.4.0-rc.1\n\nrc notes\n\n## 0.4.0\n\nreal notes\n'

    expect(versionSection(ambiguous, '0.4.0')).toBe('real notes')
  })
})

describe('releaseNotes', () => {
  it('states a summary once however many packages carry a copy of it', () => {
    const notes = releaseNotes([CORE, RUNTIME], '0.4.0')

    expect(notes).toBe(
      [
        '### Minor Changes',
        '',
        '- abc1234: The summary someone wrote.',
        '',
        '  A second paragraph of it.',
      ].join('\n'),
    )
    // The duplication this exists to collapse: 0.3.0 carries one ~300-line
    // essay in all seven packages.
    expect(notes.match(/The summary someone wrote/g)).toHaveLength(1)
  })

  it('finds the summaries when they are in packages other than core', () => {
    // 0.2.0's shape: core bumped with an empty section while the line changed.
    const emptyCore = '## 0.4.0\n\n## 0.3.0\n'

    expect(releaseNotes([emptyCore, RUNTIME], '0.4.0')).toContain('The summary someone wrote')
  })

  it('drops the dependency bookkeeping, which names only packages in this release', () => {
    const notes = releaseNotes([CORE, RUNTIME], '0.4.0')

    expect(notes).not.toContain('Updated dependencies')
    expect(notes).not.toContain('Patch Changes')
  })

  it('drops a dependency bump written without the "Updated dependencies" line', () => {
    // 0.2.0's real spelling across discovery, runtime and adapters: the bullet
    // is the package reference itself. It is the same bookkeeping, and it
    // reached the v0.2.0 release page before this case existed.
    const bare = '## 0.4.0\n\n### Patch Changes\n\n- @orchestral/core@0.4.0\n'
    const nested =
      '## 0.4.0\n\n### Patch Changes\n\n- @orchestral/core@0.4.0\n  - @orchestral/discovery@0.4.0\n'

    expect(releaseNotes([bare], '0.4.0')).toBeNull()
    expect(releaseNotes([nested], '0.4.0')).toBeNull()
    expect(releaseNotes([CORE, bare, nested], '0.4.0')).not.toContain('@orchestral/core@0.4.0')
  })

  it('keeps a summary that merely mentions a package and version', () => {
    // The stop against over-matching: `- <sha>: text` is news however many
    // package references the text goes on to carry.
    const summary =
      '## 0.4.0\n\n### Minor Changes\n\n- aa11bb: Bumped the floor to @orchestral/core@0.4.0.\n'

    expect(releaseNotes([summary], '0.4.0')).toContain('Bumped the floor')
  })

  it('returns null when every section is bookkeeping, rather than empty notes', () => {
    // The workflow turns this into a failed step. A release whose body is
    // "updated dependencies" says nothing about a version already on the
    // registry — the one outcome worse than a missing release.
    expect(releaseNotes([PATTERNS], '0.4.0')).toBeNull()
    expect(releaseNotes([CORE], '9.9.9')).toBeNull()
  })

  it('groups the distinct summaries under the heading each was written under', () => {
    const fix = '## 0.4.0\n\n### Patch Changes\n\n- ff00ff: A fix nobody else carries.\n'

    expect(releaseNotes([CORE, fix], '0.4.0')).toBe(
      [
        '### Minor Changes',
        '',
        '- abc1234: The summary someone wrote.',
        '',
        '  A second paragraph of it.',
        '',
        '### Patch Changes',
        '',
        '- ff00ff: A fix nobody else carries.',
      ].join('\n'),
    )
  })
})

describe('the CHANGELOGs the workflow actually reads', () => {
  it('covers every published package and no private one', () => {
    const published = publishedChangelogs(ROOT).map((p) => p.name)
    const onDisk = readdirSync(join(ROOT, 'packages')).filter((dir) => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'))
      return pkg.private !== true
    })

    expect(published).toHaveLength(onDisk.length)
    expect(published).toContain('@orchestral/core')
    // dsh-plugin is `private: true` — it versions against its dev-preview host
    // and is not part of the line this release announces.
    expect(published).not.toContain('@orchestral/dsh-plugin')
  })

  it("builds a non-empty body for the version a release would be cut for now", () => {
    // The self-check: everything above proves the parser parses the samples.
    // This proves the samples still describe the real files, for the version
    // the workflow would announce on the next push.
    const version = JSON.parse(
      readFileSync(join(ROOT, 'packages/orchestral-core/package.json'), 'utf8'),
    ).version
    const notes = releaseNotes(
      publishedChangelogs(ROOT).map((p) => p.changelog),
      version,
    )

    expect(notes, `no changeset summary for ${version} in any published CHANGELOG`).not.toBeNull()
    expect(notes).toContain('###')
    expect(notes).not.toContain('Updated dependencies')
  })
})
