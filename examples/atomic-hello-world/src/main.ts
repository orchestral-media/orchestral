// Atomic hello-world — the whole host.
//
// A from-scratch host needs ONLY the published @orchestral/* packages plus its
// own ai-sdk model instance (built with its own API key) and a small adapter
// that bridges that instance to the orchestral `call` contract. That adapter is
// host territory — core / runtime / patterns never import a provider SDK — so it
// lives here in `./ai-sdk-wiring`, not in a published package. Everything below
// the `OPENAI_API_KEY` check is the ~15 lines of wiring: registry → models →
// router → runtime → submitJob.

import { openai } from '@ai-sdk/openai'
import {
  createDefaultCapabilityRouter,
  InMemoryJobStore,
  PatternRegistry,
} from '@orchestral/core'
import {
  createTextToImagePattern,
  TEXT_TO_IMAGE_PATTERN_ID,
  type TextToImageOutput,
} from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createImageModels } from './ai-sdk-wiring'

if (!process.env.OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI_API_KEY.\n' +
      'Export a key first, e.g.  export OPENAI_API_KEY=sk-...\n' +
      '(no key? run `pnpm --filter atomic-hello-world test` — the smoke test ' +
      'exercises the same wiring with a mock model and needs no key.)',
  )
  process.exit(1)
}

// 1. Register the atomic Pattern we want to dispatch. `registry.add` is generic
//    over the Pattern's I/O, so a fully-typed factory result drops straight in.
const registry = new PatternRegistry()
registry.add(createTextToImagePattern())

// 2. Declare which model serves text-to-image. The model instance is ours —
//    @ai-sdk/openai builds it from OPENAI_API_KEY in the environment.
//    `createImageModels` (./ai-sdk-wiring) packs it into the ModelCapability
//    envelope the router consumes, with `call` wired through ai-sdk.
const getModels = createImageModels([
  {
    provider: 'openai',
    modelId: 'gpt-image-1',
    model: openai.image('gpt-image-1'),
  },
])

// 3. Default router. No getCapabilityOrder → enablement gate off, so every
//    declared model is a routing candidate (fine for a single-model demo).
const router = createDefaultCapabilityRouter({ getModels })

// 4. In-process runtime over the zero-dependency in-memory JobStore.
const runtime = new InlineRuntime({
  store: new InMemoryJobStore(),
  registry,
  router,
})

// 5. Dispatch. InlineRuntime runs synchronously in this tick — the awaited Job
//    is already `done`, no polling or subscription needed.
const job = await runtime.submitJob<{ prompt: string }, TextToImageOutput>({
  patternId: TEXT_TO_IMAGE_PATTERN_ID,
  input: { prompt: 'a red bicycle' },
})

if (job.status !== 'done' || !job.output) {
  console.error(`Dispatch did not complete: status=${job.status}`, job.error)
  process.exit(1)
}

const { assets, model, provider, latencyMs } = job.output
console.log(`Generated ${assets.length} image(s) via ${provider} (${model}) in ${latencyMs}ms`)
for (const [i, asset] of assets.entries()) {
  // The standalone host has no asset store, so `url` is a data URI.
  const uri = asset.url ?? '(no uri)'
  const preview = uri.length > 64 ? `${uri.slice(0, 64)}…` : uri
  console.log(`  [${i}] ${asset.modality} — ${preview}`)
}
