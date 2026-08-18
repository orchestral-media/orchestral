# Contributing

Orchestral is maintained by one person alongside other work. Issues and pull
requests are welcome, but responses are best-effort — expect days, sometimes
longer, and no guarantee that a given change is accepted.

## Issues

Bug reports are more useful than feature requests. A good one has the versions
of the three packages, a minimal reproduction (the `examples/` hosts are a fine
starting point), and the actual error output rather than a description of it.

If you are unsure whether something is a bug or a design decision, open an
issue and ask before writing code.

## Pull requests

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm api:check
pnpm lint
```

`pnpm build` comes first because api-extractor reads each package's generated
declarations (`dts/index.d.ts`), which the build emits — on a fresh clone
`pnpm api:check` fails without it. All five must pass; CI runs them in this
same order, interleaved with `pnpm docs:catalog` and
`node scripts/smoke-dist.mjs`.

- **`pnpm api:check` fails when the public type surface changes.** That is the
  point — review the diff, run `pnpm api:update`, and commit the updated
  `packages/*/etc/*.api.md` report with your change so the API delta is visible
  in review.
- **New behaviour needs a test.** The packages have no I/O and no provider SDK,
  so almost everything is directly unit-testable.
- **Adding or changing a pattern?** The catalog table in
  `packages/orchestral-patterns/README.md` is generated. Run `pnpm build &&
  pnpm docs:catalog` and commit the regenerated table.
- **Keep patterns provider-agnostic.** Model-specific parameters do not belong
  on a pattern's input schema; they arrive through the host-supplied
  `providerOptions` lift.

## Style

Biome is a lint gate, not a formatter: `pnpm lint` is what CI runs, and
`biome.json` has the formatter switched off deliberately. Do not reformat files
you are not otherwise changing — match the surrounding code, and prefer a
comment explaining *why* over one restating *what*.

## Legal

Contributions are accepted under the repository's Apache-2.0 license. There is
no CLA and no DCO sign-off requirement — opening a pull request is taken as
agreement that your contribution ships under that license.
