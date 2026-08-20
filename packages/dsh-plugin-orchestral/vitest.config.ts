import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'dsh-plugin-orchestral',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
