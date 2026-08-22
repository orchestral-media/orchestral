// Publish-artifact smoke test for the published @orchestral/* packages.
//
// Why this exists: every unit test and the atomic-hello-world example resolve
// the three packages through `workspace:*`, and each package's top-level
// `main`/`exports` points at `./src/index.ts` (publishConfig.main → ./dist is
// only applied by npm at publish time). So the tsdown-built `dist/index.js` —
// the code npm actually ships — is never imported or executed by any test.
// api-surface CI only builds + api-extractor-checks the `.d.ts` type surface,
// not the runtime JS. This script closes that gap: it imports the built
// dist/index.js directly by file URL and runs the hello-world flow end to end
// (register atomic Pattern → InlineRuntime dispatch → validate output).
//
// The catch: patterns' and runtime's dist externalize `@orchestral/core` as a
// bare `import ... from "@orchestral/core"`. In this workspace that specifier
// resolves to core's src/index.ts (unrunnable TS) — the exact "dist links to
// dist" path a consumer of the published packages relies on is untested. A
// module resolve hook (below) redirects the three `@orchestral/*` specifiers to
// their dist builds, simulating the post-publish resolution without touching
// any package.json.
//
// Run `pnpm smoke:dist` (builds first) or `node scripts/smoke-dist.mjs` against
// an already-built tree (CI reuses the api-surface build).

import { existsSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The published packages and their single published entry (`.`). Each
// package's publishConfig.exports declares only `.` → ./dist/index.js.
const PACKAGES = [
  { name: '@orchestral/core', dir: 'orchestral-core' },
  { name: '@orchestral/discovery', dir: 'orchestral-discovery' },
  { name: '@orchestral/patterns', dir: 'orchestral-patterns' },
  { name: '@orchestral/runtime', dir: 'orchestral-runtime' },
  { name: '@orchestral/agent', dir: 'orchestral-agent' },
  // The AI SDK adapters are a leaf on the same version line. Their dist
  // externalizes `ai` as a bare import, which resolves through the package's
  // own node_modules — the same resolution a consumer gets after publish.
  { name: '@orchestral/adapters-ai-sdk', dir: 'orchestral-adapters-ai-sdk' },
]

const distUrlFor = (dir) =>
  new URL(`../packages/${dir}/dist/index.js`, import.meta.url)

// Fail readably (before any import) if a dist is missing — the script assumes a
// built tree. This is the guard that turns "forgot to build" into a clear
// message instead of a raw ERR_MODULE_NOT_FOUND.
const missing = PACKAGES.filter((p) => !existsSync(distUrlFor(p.dir)))
if (missing.length > 0) {
  console.error('smoke:dist — missing build artifacts:\n')
  for (const p of missing) {
    console.error(`  ✗ ${p.name}: ${fileURLToPath(distUrlFor(p.dir))} not found`)
  }
  console.error(
    '\nBuild the packages first, then re-run:\n' +
      '  pnpm -r --filter "./packages/orchestral-*" build\n' +
      '  node scripts/smoke-dist.mjs\n' +
      '(or just `pnpm smoke:dist`, which builds then runs this script).',
  )
  process.exit(1)
}

// Redirect bare `@orchestral/*` specifiers to the built dist. Without this, the
// transitive `@orchestral/core` import inside patterns'/runtime's dist resolves
// to core's src/index.ts (TS) and crashes. Mapping every specifier — including
// the top-level three — to the same dist URLs keeps a single module instance
// per package. The hook source is a self-contained data: URL module; the URL
// map is baked in as JSON so the (separate-thread) hook needs no other plumbing.
const specifierToDist = Object.fromEntries(
  PACKAGES.map((p) => [p.name, distUrlFor(p.dir).href]),
)
const hookSource = `
const MAP = ${JSON.stringify(specifierToDist)}
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(MAP, specifier)) {
    return { url: MAP[specifier], shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url)

// ── assertions ─────────────────────────────────────────────────────────────
let failures = 0
function check(pkg, label, ok) {
  if (ok) {
    console.log(`  ✓ [${pkg}] ${label}`)
  } else {
    console.error(`  ✗ [${pkg}] ${label}`)
    failures++
  }
}

// Import the published dist directly by file URL (top-level entries); the hook
// covers each package's transitive `@orchestral/*` imports.
const core = await import(distUrlFor('orchestral-core').href)
const discovery = await import(distUrlFor('orchestral-discovery').href)
const patterns = await import(distUrlFor('orchestral-patterns').href)
const runtime = await import(distUrlFor('orchestral-runtime').href)
const agent = await import(distUrlFor('orchestral-agent').href)
const adapters = await import(distUrlFor('orchestral-adapters-ai-sdk').href)

console.log('smoke:dist — exercising built dist/index.js of the published packages\n')

// 1. Key exports are present and of the right kind. If any is missing the flow
//    below can't run, so bail early with a precise message.
console.log('exports:')
check('@orchestral/core', 'PatternRegistry is a constructor', typeof core.PatternRegistry === 'function')
check('@orchestral/core', 'InMemoryJobStore is a constructor', typeof core.InMemoryJobStore === 'function')
check('@orchestral/core', 'createDefaultCapabilityRouter is a function', typeof core.createDefaultCapabilityRouter === 'function')
check('@orchestral/patterns', 'createTextToImagePattern is a function', typeof patterns.createTextToImagePattern === 'function')
check('@orchestral/patterns', 'TEXT_TO_IMAGE_PATTERN_ID === "text-to-image"', patterns.TEXT_TO_IMAGE_PATTERN_ID === 'text-to-image')
check('@orchestral/patterns', 'TextToImageOutputSchema.parse is a function', typeof patterns.TextToImageOutputSchema?.parse === 'function')
check('@orchestral/runtime', 'InlineRuntime is a constructor', typeof runtime.InlineRuntime === 'function')
check('@orchestral/discovery', 'PatternSearchIndex is a constructor', typeof discovery.PatternSearchIndex === 'function')
check('@orchestral/discovery', 'handleFindPattern is a function', typeof discovery.handleFindPattern === 'function')
// The agent package publishes its one Pattern factory and nothing else — no
// tool-loop runner (that is host territory, same as ModelCapability.call), so
// there is no runner export to assert here.
check('@orchestral/agent', 'createOrchestratorAgent is a function', typeof agent.createOrchestratorAgent === 'function')
check('@orchestral/adapters-ai-sdk', 'fromImageModel is a function', typeof adapters.fromImageModel === 'function')
check('@orchestral/adapters-ai-sdk', 'fromSpeechModel is a function', typeof adapters.fromSpeechModel === 'function')
check('@orchestral/adapters-ai-sdk', 'fromTranscriptionModel is a function', typeof adapters.fromTranscriptionModel === 'function')
check('@orchestral/adapters-ai-sdk', 'fromLanguageModel is a function', typeof adapters.fromLanguageModel === 'function')
check('@orchestral/adapters-ai-sdk', 'fromVisionModel is a function', typeof adapters.fromVisionModel === 'function')

if (failures > 0) {
  console.error(`\nsmoke:dist FAILED — ${failures} missing/invalid export(s); cannot run the dispatch flow.`)
  process.exit(1)
}

// 2. Minimal end-to-end dispatch, mirroring examples/atomic-hello-world but with
//    an inline `call` (the ai-sdk bridge is host territory, never shipped by the
//    packages). The `call` returns a TextToImageOutput shaped exactly like the
//    hello-world wiring output so the pattern's own schema validates it.
const PNG_DATA_URI =
  'data:image/png;base64,aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='

function inlineImageModels() {
  const envelope = {
    capabilities: ['text-to-image'],
    provider: 'mock',
    modelId: 'mock-image',
    inputs: ['text'],
    outputs: ['image'],
    tags: [],
    source: 'user',
    async call(input, _ctx, events) {
      const prompt = input && typeof input === 'object' ? input.prompt : undefined
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('text-to-image call: input.prompt (non-empty string) is required')
      }
      const artifact = { kind: 'image', uri: PNG_DATA_URI, mime: 'image/png' }
      events?.onArtifact?.(artifact)
      const output = {
        modality: 'image',
        // No `url`: the bytes are the artifact above. See the adapters README.
        assets: [{ assetId: 'mock-image-0', modality: 'image' }],
        cost: 0,
        latencyMs: 1,
        model: 'mock:mock-image',
        provider: 'mock',
      }
      return { output, artifacts: [artifact] }
    },
  }
  return (cap) => [envelope].filter((env) => env.capabilities.includes(cap))
}

console.log('\ndispatch:')
// The bytes travel on `job:artifact`, not in the output. Collected from the
// creation hook, because `submitJob` resolves at terminal — after every event
// has already fired.
const artifacts = []
let job
try {
  const registry = new core.PatternRegistry()
  registry.add(patterns.createTextToImagePattern())

  const router = core.createDefaultCapabilityRouter({ getModels: inlineImageModels() })
  const rt = new runtime.InlineRuntime({
    store: new core.InMemoryJobStore(),
    registry,
    router,
    onJobCreated: (id) =>
      rt.subscribe(id, (ev) => {
        if (ev.type === 'job:artifact') artifacts.push(ev.artifact)
      }),
  })

  job = await rt.submitJob({
    patternId: patterns.TEXT_TO_IMAGE_PATTERN_ID,
    input: { prompt: 'a red bicycle' },
  })
} catch (err) {
  console.error('  ✗ [@orchestral/runtime] submitJob threw instead of completing:')
  console.error(err)
  process.exit(1)
}

// 3. The job ran to completion in this tick and carries a usable output.
check('@orchestral/runtime', 'job.status === "done"', job.status === 'done')
check('@orchestral/runtime', 'job.error is null/undefined', job.error == null)
check('@orchestral/runtime', 'job.output is present', job.output != null)

// 4. The output satisfies the real patterns schema — the load-bearing contract
//    a host relies on when consuming job.output. Parsing exercises the zod
//    schema that lives in the patterns dist bundle.
let parsed
try {
  parsed = patterns.TextToImageOutputSchema.parse(job.output)
  check('@orchestral/patterns', 'TextToImageOutputSchema.parse(job.output) succeeds', true)
} catch (err) {
  check('@orchestral/patterns', 'TextToImageOutputSchema.parse(job.output) succeeds', false)
  console.error(err)
}

if (parsed) {
  check('@orchestral/patterns', 'parsed.modality === "image"', parsed.modality === 'image')
  check('@orchestral/patterns', 'parsed.model === "mock:mock-image"', parsed.model === 'mock:mock-image')
  check('@orchestral/patterns', 'parsed.provider === "mock"', parsed.provider === 'mock')
  check('@orchestral/patterns', 'parsed.assets has one image asset', parsed.assets.length === 1 && parsed.assets[0]?.modality === 'image')
  check('@orchestral/patterns', 'asset.url is unset (bytes are never inlined in the output)', parsed.assets[0]?.url === undefined)
  check('@orchestral/runtime', 'job:artifact delivered the png data URI', artifacts.length === 1 && /^data:image\/png;base64,/.test(artifacts[0]?.uri ?? ''))
}

// 5. The same dispatch through the shipped AI SDK adapter instead of the
//    inline `call`: proves the adapters dist links to `ai` post-publish and
//    produces the same schema-valid output. The model is ai/test's mock,
//    resolved from the adapters package's own node_modules (the root has no
//    `ai`), so no key and no network.
console.log('\ndispatch via @orchestral/adapters-ai-sdk:')
const adaptersRequire = createRequire(
  new URL('../packages/orchestral-adapters-ai-sdk/package.json', import.meta.url),
)
const { MockImageModelV3, MockLanguageModelV3 } = await import(pathToFileURL(adaptersRequire.resolve('ai/test')).href)
let adapterJob
const adapterArtifacts = []
try {
  const registry = new core.PatternRegistry()
  registry.add(patterns.createTextToImagePattern())
  const envelope = adapters.fromImageModel(
    new MockImageModelV3({
      provider: 'openai',
      modelId: 'gpt-image-1',
      doGenerate: async () => ({
        images: ['aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0E='],
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'gpt-image-1', headers: {} },
      }),
    }),
  )
  const rt = new runtime.InlineRuntime({
    store: new core.InMemoryJobStore(),
    registry,
    router: core.createDefaultCapabilityRouter({
      getModels: (cap) => [envelope].filter((env) => env.capabilities.includes(cap)),
    }),
    onJobCreated: (id) =>
      rt.subscribe(id, (ev) => {
        if (ev.type === 'job:artifact') adapterArtifacts.push(ev.artifact)
      }),
  })
  adapterJob = await rt.submitJob({
    patternId: patterns.TEXT_TO_IMAGE_PATTERN_ID,
    input: { prompt: 'a red bicycle' },
  })
} catch (err) {
  console.error('  ✗ [@orchestral/adapters-ai-sdk] submitJob threw instead of completing:')
  console.error(err)
  process.exit(1)
}
check('@orchestral/adapters-ai-sdk', 'job.status === "done"', adapterJob.status === 'done')
let adapterParsed
try {
  adapterParsed = patterns.TextToImageOutputSchema.parse(adapterJob.output)
  check('@orchestral/adapters-ai-sdk', 'TextToImageOutputSchema.parse(job.output) succeeds', true)
} catch (err) {
  check('@orchestral/adapters-ai-sdk', 'TextToImageOutputSchema.parse(job.output) succeeds', false)
  console.error(err)
}
if (adapterParsed) {
  check('@orchestral/adapters-ai-sdk', 'parsed.model === "openai:gpt-image-1"', adapterParsed.model === 'openai:gpt-image-1')
  check('@orchestral/adapters-ai-sdk', 'parsed.cost === null (the AI SDK reports no cost)', adapterParsed.cost === null)
  check('@orchestral/adapters-ai-sdk', 'asset.url is unset (bytes are never inlined in the output)', adapterParsed.assets[0]?.url === undefined)
  check('@orchestral/adapters-ai-sdk', 'job:artifact delivered the png data URI', adapterArtifacts.length === 1 && /^data:image\/png;base64,/.test(adapterArtifacts[0]?.uri ?? ''))
}

// 6. text-generation through the shipped language-model adapter — the
//    capability every first-party meta dispatches. Same shape as the image
//    section above: the adapters dist links to `generateText` post-publish and
//    returns the first-party TextGenerationOutput.
console.log('\ndispatch text-generation via @orchestral/adapters-ai-sdk:')
let textJob
try {
  const registry = new core.PatternRegistry()
  registry.add(patterns.createTextGenerationPattern())
  const envelope = adapters.fromLanguageModel(
    new MockLanguageModelV3({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'A red bicycle.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  )
  const rt = new runtime.InlineRuntime({
    store: new core.InMemoryJobStore(),
    registry,
    router: core.createDefaultCapabilityRouter({
      getModels: (cap) => [envelope].filter((env) => env.capabilities.includes(cap)),
    }),
  })
  textJob = await rt.submitJob({
    patternId: patterns.TEXT_GENERATION_PATTERN_ID,
    input: { prompt: 'Name one thing in the picture.' },
  })
} catch (err) {
  console.error('  ✗ [@orchestral/adapters-ai-sdk] submitJob threw instead of completing:')
  console.error(err)
  process.exit(1)
}
check('@orchestral/adapters-ai-sdk', 'job.status === "done"', textJob.status === 'done')
let textParsed
try {
  textParsed = patterns.TextGenerationOutputSchema.parse(textJob.output)
  check('@orchestral/adapters-ai-sdk', 'TextGenerationOutputSchema.parse(job.output) succeeds', true)
} catch (err) {
  check('@orchestral/adapters-ai-sdk', 'TextGenerationOutputSchema.parse(job.output) succeeds', false)
  console.error(err)
}
if (textParsed) {
  check('@orchestral/adapters-ai-sdk', 'parsed.text === "A red bicycle."', textParsed.text === 'A red bicycle.')
  check('@orchestral/adapters-ai-sdk', 'parsed.model === "openai:gpt-4o-mini"', textParsed.model === 'openai:gpt-4o-mini')
  check('@orchestral/adapters-ai-sdk', 'parsed.cost === null (the AI SDK reports no cost)', textParsed.cost === null)
  check('@orchestral/adapters-ai-sdk', 'parsed.usage carries both token counts', textParsed.usage?.inputTokens === 10 && textParsed.usage?.outputTokens === 4)
  check('@orchestral/adapters-ai-sdk', 'parsed.finishReason === "stop"', textParsed.finishReason === 'stop')
}

if (failures > 0) {
  console.error(`\nsmoke:dist FAILED — ${failures} assertion(s) failed against the built dist.`)
  process.exit(1)
}
console.log('\nsmoke:dist PASSED — all dist bundles link and dispatch end to end.')
