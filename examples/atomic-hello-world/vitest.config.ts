import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'atomic-hello-world',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
