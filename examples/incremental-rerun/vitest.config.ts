import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'incremental-rerun',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
