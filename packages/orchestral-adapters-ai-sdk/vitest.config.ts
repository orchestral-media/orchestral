import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'orchestral-adapters-ai-sdk',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
