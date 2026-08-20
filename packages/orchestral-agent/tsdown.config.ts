import { defineConfig } from 'tsdown'

// JS bundle only. Declarations are emitted per-file by tsc (tsconfig.build.json)
// and rolled into a single dist/index.d.ts by api-extractor (see package.json
// build) — same split as @orchestral/patterns, for the same reason
// (rolldown-plugin-dts misplaces JSDoc on type-literal members).
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: false,
  sourcemap: true,
  // type:module makes the .js extension valid ESM; matches publishConfig.
  outExtensions: () => ({ js: '.js' }),
})
