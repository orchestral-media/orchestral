# Changesets

Releases ride [changesets](https://github.com/changesets/changesets). A PR
that changes a published package adds one:

```sh
pnpm changeset
```

Pick the packages, pick the bump, write one or two sentences a consumer would
want in the CHANGELOG. The six `@orchestral/*` packages are a **fixed group**
— one version line, so any bump moves all six together, which is the
documented contract (every CHANGELOG says "pin `~0.1`").

What happens on merge is `.github/workflows/release.yml`'s job: pending
changesets accumulate into a "Version Packages" PR; merging THAT PR runs the
full verification gate and publishes. `@orchestral/dsh-plugin` is in
`ignore` on purpose — it versions against its dev-preview host and publishes
manually (PUBLISH.md §7). Never give it a changeset, and never tick it in
`pnpm changeset` alongside the six: changesets refuses a changeset that
mixes ignored and released packages, and the refusal lands as a red release
run on main.

Details and the manual fallback: `PUBLISH.md`.
