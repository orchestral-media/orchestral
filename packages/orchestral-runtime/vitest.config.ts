import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-runtime',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
