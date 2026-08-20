import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-agent',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
