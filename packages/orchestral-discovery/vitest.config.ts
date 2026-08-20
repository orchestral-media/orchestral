import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-discovery',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
