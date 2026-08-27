import { defineConfig } from 'tsdown'

// JS bundle only. Declarations are emitted per-file by tsc (tsconfig.build.json)
// and rolled into a single dist/index.d.ts by api-extractor (see package.json
// build). rolldown-plugin-dts is bypassed because it misplaces JSDoc on
// type-literal members (sxzz/rolldown-plugin-dts#182); tsc + api-extractor
// preserve leading comments faithfully.
export default defineConfig({
  entry: ['src/index.ts', 'src/memory.ts', 'src/routing.ts'],
  format: 'esm',
  dts: false,
  sourcemap: true,
  // type:module makes the .js extension valid ESM; matches publishConfig.
  outExtensions: () => ({ js: '.js' }),
})
