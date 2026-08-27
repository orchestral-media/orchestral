import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-plan',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
