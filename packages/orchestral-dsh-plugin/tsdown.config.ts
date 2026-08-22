import { defineConfig } from 'tsdown'

// JS bundle + per-file declarations straight from tsdown.
//
// The five @orchestral/* packages roll their .d.ts through tsc +
// api-extractor because they publish a reviewed API report (etc/*.api.md) that
// `pnpm api:check` diffs. This bridge deliberately has none: it is experimental,
// explicitly outside the orchestral API contract, and on its own version line —
// a report here would be a contract it does not want to make. So it emits
// declarations directly and skips the rollup step.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  sourcemap: true,
  // type:module makes the .js extension valid ESM; matches publishConfig.
  outExtensions: () => ({ js: '.js' }),
})
