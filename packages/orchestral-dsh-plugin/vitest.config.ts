import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@orchestral/dsh-plugin',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
