# Publishing Orchestral

Maintainer handbook for releasing to npm. Everything here is manual on purpose
— there is no release automation and no publish workflow in CI.

Two version lines ship from this repo:

- **`@orchestral/*`** — `core`, `discovery`, `runtime`, `patterns`, `agent`,
  `adapters-ai-sdk`. Six packages on one version line, released together.
- **`@orchestral/dsh-plugin`** — the deepseek-harness bridge, versioned
  independently against its dev-preview host (see §7).

## 0. First push (once)

This repository starts from a fresh history, so the first push has nothing to
merge and nothing to rebase onto.

Check that `pnpm-lock.yaml` is committed before pushing. CI installs with
`--frozen-lockfile`, so a history whose first commit has no lockfile fails on
its very first run. If it is missing, run `pnpm install` and commit it.

```sh
# create an EMPTY repo at github.com/orchestral-media/orchestral first —
# no README, no license, no .gitignore
git remote add origin git@github.com:orchestral-media/orchestral.git
git push -u origin main
```

Then, in the repository settings: enable **private vulnerability reporting**
(Settings → Code security), which is the channel `SECURITY.md` points people
at.

## 1. Claim the npm scope

`@orchestral` is not a username scope, so it has to exist as an npm
organization before anything can be published under it. Creating one is free
for public packages: <https://www.npmjs.com/org/create> → name `orchestral`.

Verify, in this order:

```sh
npm whoami                        # you are logged in, and as whom
npm org ls orchestral             # you appear, as owner — proves the scope is yours
npm access list packages @orchestral   # what already exists under the scope
npm view @orchestral/core         # 404 until the first publish
```

`npm view @orchestral/core` returning 404 only means the *package name* is
unused — it is not evidence that the scope belongs to you. `npm org ls` is the
check that matters. Publishing into a scope you do not own fails with `E403`
after the tarball is already built, which is a confusing place to discover it.

> Measured 2026-08-16: `npm view @orchestral/core` → `404`. The scope's
> ownership was not verified at that point.

## 2. Always `pnpm publish`, never `npm publish`

Each package's top-level `main` / `types` / `exports` point at `./src/index.ts`
so the workspace and the examples run TypeScript sources directly. The
published shape lives in `publishConfig`. **pnpm** substitutes those fields (and
resolves `workspace:*` to a real version) when it packs; **npm** does not — npm
only honours a handful of `publishConfig` keys (`registry`, `access`, `tag`),
not `main`/`types`/`exports`.

Publishing with npm therefore ships a package whose entry point is a `.ts` file
that is not even in the tarball (`files` lists `dist`). It installs and then
fails at import.

Measured 2026-08-16 (pnpm 10.28.1, npm bundled with Node 24.17.0), unpacking
the tarball and reading `package/package.json`:

| | `npm pack` | `pnpm pack` |
| --- | --- | --- |
| `main` | `./src/index.ts` | `./dist/index.js` |
| `types` | `./src/index.ts` | `./dist/index.d.ts` |
| `exports["."]` | `./src/index.ts` | `{ types: ./dist/index.d.ts, import: ./dist/index.js }` |
| `dependencies["@orchestral/core"]` (patterns) | `workspace:*` | `0.1.0` |

`pnpm pack` also drops the dev-only `./testing` subpath from
`@orchestral/patterns` (it is absent from `publishConfig.exports`), which is
intended — there is no dist artifact behind it.

If you ever want to inspect a tarball without triggering the `prepack` build,
`npm_config_ignore_scripts=true pnpm pack --pack-destination /tmp/x` works;
`pnpm pack` has no `--ignore-scripts` flag of its own.

## 3. Pre-flight

From a clean tree on `main`, with CI green:

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm api:check
pnpm lint
node scripts/smoke-dist.mjs     # or `pnpm smoke:dist`, which rebuilds first
```

`scripts/smoke-dist.mjs` is the one check that exercises what npm actually
ships: it imports each package's built `dist/index.js` by file URL, redirects
the bare `@orchestral/*` specifiers between them to their dist builds (the
resolution a consumer gets after publish, which no test covers), and runs a
registry → router → runtime dispatch end to end. Do not skip it — every other
gate reads either the sources or the `.d.ts`.

If any pattern changed since the last release, regenerate the catalog table in
`packages/orchestral-patterns/README.md` — it is derived from the built dist and
ships inside the tarball:

```sh
pnpm docs:catalog
git diff --exit-code packages/orchestral-patterns/README.md   # commit if it moved
```

Set the release date. Each package's `CHANGELOG.md` heads its section with
`## [0.1.0] — Initial public release` and no date, because the date is only
true once the publish lands. Fill it in on the day:

```sh
# six packages, one line each
grep -rn '^## \[0.1.0\]' packages/*/CHANGELOG.md
```

Version bump, when releasing something other than the current `0.1.0`:

- The six `@orchestral/*` packages move together; keep the version line
  identical. `@orchestral/dsh-plugin` does not — bump it on its own.
- Update each package's `CHANGELOG.md`.
- Internal dependencies are all `workspace:*`, so nothing else needs editing —
  pnpm resolves them to the real version at pack time.
- Commit the bump before publishing; `pnpm publish` refuses a dirty tree.

## 4. Publish, in dependency order

Each `pnpm publish` runs that package's `prepack` (a full `build`) first, so
the dist in the tarball is always freshly built.

```sh
pnpm --filter @orchestral/core publish --access public
pnpm --filter @orchestral/adapters-ai-sdk publish --access public
pnpm --filter @orchestral/discovery publish --access public
pnpm --filter @orchestral/runtime publish --access public
pnpm --filter @orchestral/patterns publish --access public
pnpm --filter @orchestral/agent publish --access public
```

Order matters: every package ships a hard dependency on the `@orchestral/*`
packages below it, so publishing one early leaves a window in which
`npm install` cannot resolve it. The graph, which is what that order is a
topological sort of:

```
core             (nothing)
adapters-ai-sdk  core            (+ `ai` as a peer; nothing depends on it)
discovery        core
runtime          core, discovery
patterns         core
agent            core, patterns, runtime
```

`patterns` and `adapters-ai-sdk` only need `core`, so they can go anywhere
after it; `patterns` sits where it does to keep `agent` — the only package
that needs all three of the others — last. `adapters-ai-sdk` is a leaf (no
`@orchestral/*` package depends on it), so its position only has to be after
`core`.

- With 2FA enabled, append `--otp=<code>` (the code expires fast — publish one
  package per code if needed).
- `pnpm publish` enforces a clean tree and the `main` branch by default. Fix
  the tree rather than reaching for `--no-git-checks`.
- `pnpm -r publish --access public` publishes every non-private package in
  topological order in one shot. It is correct, but the explicit commands fail
  more legibly, and it would sweep up `@orchestral/dsh-plugin` — which is on
  its own version line — along with the six. `examples/*` being
  `private: true` is the only thing keeping those out of it.
- A mistaken publish can be undone within 72 hours (`npm unpublish
  @orchestral/core@0.1.0`). After that, the version is permanent — publish a
  new patch instead.

## 5. Tag and release

```sh
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file <notes>
```

Notes are assembled by hand from the six `CHANGELOG.md` files. One tag and
one GitHub Release per version line, since the packages move together.

## 6. Verify what consumers get

Install from the registry into a throwaway directory — not a workspace, so
nothing resolves to a local path:

```sh
mkdir /tmp/orchestral-verify && cd /tmp/orchestral-verify
npm init -y
npm install @orchestral/core@0.1.0 @orchestral/patterns@0.1.0 @orchestral/runtime@0.1.0 zod
node --input-type=module -e "
  import { PatternRegistry, InMemoryJobStore } from '@orchestral/core'
  import { InlineRuntime } from '@orchestral/runtime'
  import { createTextToImagePattern } from '@orchestral/patterns'
  console.log(typeof PatternRegistry, typeof InMemoryJobStore, typeof InlineRuntime, typeof createTextToImagePattern)
"

# the two optional packages, which a host installs only if it wants them
npm install @orchestral/discovery@0.1.0 @orchestral/agent@0.1.0
node --input-type=module -e "
  import { PatternSearchIndex } from '@orchestral/discovery'
  import { createOrchestratorAgent } from '@orchestral/agent'
  console.log(typeof PatternSearchIndex, typeof createOrchestratorAgent)
"
```

# the AI SDK adapters, which a host installs only if it is on the AI SDK
npm install @orchestral/adapters-ai-sdk@0.1.0 ai
node --input-type=module -e "
  import { fromImageModel } from '@orchestral/adapters-ai-sdk'
  console.log(typeof fromImageModel)
"
```

Four `function`s (then two more, then one more) means the published entry points, the type
surface and the cross-package resolution all landed. `@orchestral/runtime`
pulling `@orchestral/discovery` in on its own is part of what the first block
proves — it is a dependency, not something the host asks for. Also check the package pages render the
README and show the Apache-2.0 license.

## 7. `@orchestral/dsh-plugin`, separately

The bridge is a leaf package on its own version line: it depends on
`@orchestral/core` and `@orchestral/runtime`, and nothing depends on it. Publish
it *after* the `@orchestral/*` line it pins, and only when you mean to — a
deepseek-harness release can break it without anything else in this repo
changing, which is exactly why it does not share the version line.

```sh
pnpm --filter @orchestral/dsh-plugin publish --access public
```

Before its first publish, run it against a real `dsh` at least once. The
package's tests are a mock `ctx` plus a typecheck against the real
`@deepseek-ai/*` types — enough to catch a signature drift, not enough to prove
the plugin loads. Booting dsh needs its build scripts approved
(`pnpm approve-builds` — `node-pty`, `esbuild`, and friends), which is a local
decision, not something CI or the tests need.

## Not set up (deliberate)

- **npm provenance.** `--provenance` requires publishing from a CI workflow
  with `id-token: write`; releases are manual, so there is no attestation.
- **Automated releases.** No changesets, no release-please, no publish job.
- **Prereleases / dist-tags.** Everything goes to `latest`. If that changes,
  `--tag next` on all six at once.
