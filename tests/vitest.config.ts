import { defineConfig } from 'vitest/config'

// Repo-level tests: things that are about the repository rather than about any
// one package. DESIGN.md sits at the root and cites every package, so a guard
// over it belongs here and not inside core's suite — a citation into
// @orchestral/runtime should not fail @orchestral/core's tests.
export default defineConfig({
  test: {
    name: 'repo',
    environment: 'node',
    include: ['*.{test,spec}.ts'],
  },
})
