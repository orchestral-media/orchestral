// long-form-video — the whole host, minus the two things it cannot ship: a
// ModelCapability per capability (your SDK, your key) and the multimedia
// backend behind the six MetaCommonDeps ops. With neither, the honest thing a
// `start` can do is register the catalog and show what a real run would need,
// so that is what this does. No key, no network, nothing dispatched.
//
// A real run = this registry + a CapabilityRouter over your models + an
// AgentRunImpl (examples/agent-hello-world/src/agent-runner.ts is the
// reference) that grants the director its `concat_videos` tool. Read the cost
// profile in the README before wiring a key in.

import { PatternRegistry, type DiagnosticsLogger } from '@orchestral/core'
import { LONG_FORM_PATTERN_IDS, registerCatalog, type LongFormHostOps } from './catalog'
import { createLongFormVideoAgent } from './patterns/agent-long-form-video'

// 1. Host ops that refuse. Every op is invoked only from inside a compose(),
//    and nothing composes here — so these are a truthful placeholder, not a
//    mock that would make a dispatch look like it worked.
const notWired = (op: string) => async (): Promise<never> => {
  throw new Error(`${op}: this example registers the catalog but wires no multimedia backend`)
}
const ops: LongFormHostOps = {
  concatVideos: notWired('concatVideos'),
  stillToVideo: notWired('stillToVideo'),
  addBackgroundAudio: notWired('addBackgroundAudio'),
  addSubtitles: notWired('addSubtitles'),
  createSubtitleAsset: notWired('createSubtitleAsset'),
  recordSessionAsset: notWired('recordSessionAsset'),
}

// 2. Register everything, collecting the registry's authoring lint instead of
//    letting it go to stderr — the text-producing long-form metas predate the
//    bounded output vocabulary and the lint names them, which is worth showing
//    rather than muting (README, "What the registry says about these patterns").
const lint: string[] = []
const logger: DiagnosticsLogger = {
  warn: (message) => {
    lint.push(message)
  },
  error: (message) => {
    lint.push(message)
  },
}
const registry = new PatternRegistry({ logger })
const { shipped, longForm } = registerCatalog(registry, ops)

// 3. Show what was registered, and where each pattern came from.
const row = (id: string, origin: string) => {
  const p = registry.get(id)
  const ops = p && 'loop' in p ? `tools: ${(p.loop.toolPatternIds ?? []).join(', ')} + concat_videos (host)` : ''
  console.log(`  ${id.padEnd(34)} ${(p?.kind ?? '?').padEnd(7)} ${origin.padEnd(22)} ${ops}`)
}
console.log(`Registered ${registry.size()} patterns.\n`)
console.log('From @orchestral/patterns:')
for (const id of shipped) row(id, '@orchestral/patterns')
console.log('\nFrom this example (src/patterns):')
for (const id of longForm) row(id, 'examples/long-form-video')

// 4. The director's tool list must resolve against this registry — the LLM
//    can only dispatch what the host registered.
const director = createLongFormVideoAgent()
const missing = director.loop.toolPatternIds.filter((id) => !registry.has(id))
console.log(
  `\n${director.id}: ${missing.length === 0 ? 'every tool it names is registered' : `MISSING ${missing.join(', ')}`}.`,
)
console.log(
  '  Its Stage 5 calls a `concat_videos` host tool that no package provides — the AgentRunImpl grants it.',
)

// 5. The lint, verbatim. Zero lines for the shipped catalog is a tested fact;
//    the lines below are all about the long-form metas.
console.log(`\nRegistry authoring lint (${lint.length} line${lint.length === 1 ? '' : 's'}):`)
for (const line of lint) console.log(`  ${line}`)
const flagged = new Set(
  lint.map((l) => /\((.+?)\)/.exec(l)?.[1]).filter((x): x is string => x !== undefined),
)
const shippedFlagged = shipped.filter((id) => flagged.has(id))
const longFormFlagged = LONG_FORM_PATTERN_IDS.filter((id) => flagged.has(id))
console.log(`  from this example: ${longFormFlagged.join(', ') || 'none'}`)
console.log(
  `  from @orchestral/patterns: ${shippedFlagged.length === 0 ? 'none (the shipped catalog is bounded end to end)' : `${shippedFlagged.join(', ')} — a regression`}`,
)

console.log(
  '\nNothing was dispatched. To run the pipeline for real: a CapabilityRouter over your models, an\n' +
    'AgentRunImpl that grants `concat_videos`, a multimedia backend behind the six MetaCommonDeps ops,\n' +
    'and a step cap sized to `maxEvents` — see README.md, "Cost profile".',
)
