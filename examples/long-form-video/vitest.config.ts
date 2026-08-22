import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'long-form-video',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
