// The edge that is not there, pinned.
//
// `@orchestral/runtime` used to depend on `@orchestral/discovery`: a host that
// installed the runtime got a BM25 engine whether it searched or not. The
// retrieval extraction cut that edge and left a seam in its place —
// `InlineRuntimeInit.patternSearch`, which a host wires to discovery's
// `createPatternSearch` or to its own search, or leaves empty.
//
// Nothing in the workspace notices if the edge comes back. Discovery stays a
// devDependency (tests here wire the first-party search through the seam), so
// it resolves either way; typecheck, tests and build read the same graph with
// or without the line. The difference exists only in what npm installs for a
// consumer, which PUBLISH.md §6 checks by hand once per release. This file is
// the standing check: the manifest itself, read the way npm will read it.
//
// Same move as @orchestral/plan's package-wiring.test.ts, whose `dependencies`
// assertion this mirrors.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

describe('@orchestral/runtime package wiring', () => {
  it('depends on core and nothing else; zod is a peer, as in every sibling', () => {
    expect(pkg.name).toBe('@orchestral/runtime')
    expect(pkg.dependencies).toEqual({ '@orchestral/core': 'workspace:*' })
    expect(pkg.peerDependencies).toEqual({ zod: '>=4.3 <5' })
  })

  it('reaches @orchestral/discovery only as a devDependency — retrieval is the host’s seam', () => {
    // Every field npm installs for a consumer. A peer or optional edge would
    // bring the engine back by another name.
    expect(pkg.dependencies ?? {}).not.toHaveProperty(['@orchestral/discovery'])
    expect(pkg.peerDependencies ?? {}).not.toHaveProperty(['@orchestral/discovery'])
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty(['@orchestral/discovery'])
    expect(pkg.devDependencies).toHaveProperty(['@orchestral/discovery'], 'workspace:*')
  })
})
