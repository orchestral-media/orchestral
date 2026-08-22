import { defineConfig } from 'vitest/config'

// Root aggregator — see Vitest 3.2+ projects field. Each entry is a leaf
// config. The examples are runnable docs; their smoke tests prove the public
// @orchestral/* wiring links end to end (no API key required).
export default defineConfig({
  test: {
    projects: [
      './packages/orchestral-core/vitest.config.ts',
      './packages/orchestral-discovery/vitest.config.ts',
      './packages/orchestral-adapters-ai-sdk/vitest.config.ts',
      './packages/orchestral-patterns/vitest.config.ts',
      './packages/orchestral-runtime/vitest.config.ts',
      './packages/orchestral-agent/vitest.config.ts',
      './packages/orchestral-dsh-plugin/vitest.config.ts',
      './examples/atomic-hello-world/vitest.config.ts',
      './examples/agent-hello-world/vitest.config.ts',
      './examples/incremental-rerun/vitest.config.ts',
      './examples/consented-fallback/vitest.config.ts',
      './examples/long-form-video/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/dts/**',
        '**/*.config.{ts,js,mjs}',
        '**/__tests__/**',
        '**/*.{test,spec}.ts',
        '**/types.ts',
      ],
    },
  },
})
