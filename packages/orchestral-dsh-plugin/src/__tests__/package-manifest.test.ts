import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// "This package is not published" is a fact about the package, not a rule
// three unrelated files have to remember. npm refuses a private package
// outright, so the root `ci:publish` --filter and the changesets `ignore`
// list stop being the load-bearing gates and become redundant belt-and-braces
// around one. Publishing it becomes what it should be: an explicit, reviewable
// one-line deletion.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  private?: boolean
  files?: readonly string[]
  publishConfig?: { access?: string }
}

describe('@orchestral/dsh-plugin package manifest', () => {
  it('is private, so npm itself is the thing that refuses to publish it', () => {
    expect(pkg.name).toBe('@orchestral/dsh-plugin')
    expect(pkg.private).toBe(true)
  })

  it('keeps the publish scaffolding intact, so un-privating is the whole change', () => {
    // The bridge WILL be published one day, against a dsh that has stopped
    // breaking. Ripping out publishConfig / files would make that day a
    // reconstruction instead of a deletion.
    expect(pkg.publishConfig?.access).toBe('public')
    expect(pkg.files).toContain('dist')
  })
})
