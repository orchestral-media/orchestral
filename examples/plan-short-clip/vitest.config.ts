import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'plan-short-clip',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
