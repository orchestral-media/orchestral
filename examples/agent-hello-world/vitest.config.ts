import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'agent-hello-world',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
