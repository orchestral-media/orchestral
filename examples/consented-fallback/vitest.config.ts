import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'consented-fallback',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
