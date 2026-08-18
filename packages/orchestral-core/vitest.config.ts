import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-core',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
