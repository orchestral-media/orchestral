// StepOptions.idempotencyKey — a meta step naming its own durable row.
//
// `JobSpec.idempotencyKey` has always been the caller-supplied override that
// bypasses `deriveIdempotencyKey` entirely, and a host submitting directly has
// always been able to pass one. A step inside a meta could not: `ctx.step`
// builds the child spec itself, so the only identities reachable from a
// `compose` were the two the derivation offers — position, or name-within-this
// -session. The asymmetry is what this option removes.
//
// What it buys that `identity: 'id'` does not: the derived key hashes
// `sessionId` ("dedup never crosses a session boundary" — idempotency.ts), so
// name-keying survives an edit to the step list but not a new session. A caller
// whose notion of "the same work" outlives a session — anything keyed on the
// content of the request rather than on the conversation it arrived in — cannot
// express it through the derivation at all.
//
// Tested end to end over a real InlineRuntime + InMemoryJobStore, because the
// property only exists across `ctx.step` → `submitChild` →
// `_submitJobInternal` → `insertIfAbsent`. The evidence is the `childJobId` on
// each `job:step` event (identical = the same row came back) and how often a
// model was actually reached.

import { describe, expect, it } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobSpec,
  MetaPattern,
  ModelCapability,
} from '@orchestral/core'
import { PatternRegistry, silentDiagnosticsLogger } from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

interface KeyedInput {
  prompt: string
  /** Omitted = whatever `deriveIdempotencyKey` decides. */
  key?: string
}

function makeRouter(prompts: string[]): CapabilityRouter {
  let serial = 0
  const cap = {
    modelId: 'fake:gen',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-gen'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call(input: unknown) {
      prompts.push((input as { prompt?: string }).prompt ?? '')
      return { output: { assetId: `img-${serial++}` } } as unknown
    },
  } as unknown as ModelCapability

  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function createFakeGenPattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-gen',
    kind: 'atomic',
    description: 'fake generator for the step idempotency-key test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

function createKeyedMeta(): MetaPattern<KeyedInput, unknown> {
  return {
    id: 'meta_keyed',
    kind: 'meta',
    description: 'one step, optionally under a caller-supplied durable key',
    outputs: z.any() as never,
    tool: { description: 'keyed', inputs: z.any() as never },
    async compose({ input }, ctx) {
      return await ctx.step<{ assetId: string }>(
        { patternId: 'fake-gen', input: { prompt: input.prompt } },
        {
          stepId: 'x',
          identity: 'id',
          ...(input.key !== undefined ? { idempotencyKey: input.key } : {}),
        },
      )
    },
  }
}

interface StepRecord {
  stepId: string
  childJobId: string
}

function makeHost() {
  const prompts: string[] = []
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(createFakeGenPattern() as never)
  registry.register(createKeyedMeta() as never)

  let collecting: StepRecord[] | undefined
  let sawRoot = false

  const runtime = new InlineRuntime({
    router: makeRouter(prompts),
    registry,
    store: new InMemoryJobStore() as never,
    onJobCreated: (jobId: string, _spec: JobSpec) => {
      if (!collecting || sawRoot) return
      sawRoot = true
      const sink = collecting
      runtime.subscribe(jobId, (ev) => {
        if (ev.type !== 'job:step') return
        sink.push({ stepId: ev.stepId, childJobId: ev.childJobId })
      })
    },
  })

  return {
    prompts,
    async run(input: KeyedInput, sessionId: string) {
      const sink: StepRecord[] = []
      collecting = sink
      sawRoot = false
      const before = prompts.length
      try {
        const job = await runtime.submitJob({
          patternId: 'meta_keyed',
          input,
          sessionId,
        } as never)
        return { job, steps: sink, dispatched: prompts.slice(before) }
      } finally {
        collecting = undefined
      }
    },
  }
}

const childOf = (steps: readonly StepRecord[]) => steps[0]?.childJobId

describe('StepOptions.idempotencyKey', () => {
  it('dedupes across sessions, which the derived key cannot', async () => {
    const host = makeHost()
    const input: KeyedInput = { prompt: 'a still of a hare', key: 'content:hare' }

    const first = await host.run(input, 'session-one')
    const second = await host.run(input, 'session-two')

    expect(first.job.status).toBe('done')
    expect(second.job.status).toBe('done')
    expect(childOf(second.steps)).toBe(childOf(first.steps))
    // The second run reached no model at all.
    expect(second.dispatched).toEqual([])
    expect(host.prompts).toEqual(['a still of a hare'])
  })

  it('without the option, the same two runs do not dedupe', async () => {
    const host = makeHost()
    const input: KeyedInput = { prompt: 'a still of a hare' }

    const first = await host.run(input, 'session-one')
    const second = await host.run(input, 'session-two')

    expect(childOf(second.steps)).not.toBe(childOf(first.steps))
    expect(host.prompts).toHaveLength(2)
  })

  it('the supplied key is authoritative: two keys over identical input are two rows', async () => {
    const host = makeHost()
    const session = 'one-session'

    const first = await host.run({ prompt: 'same', key: 'k1' }, session)
    const second = await host.run({ prompt: 'same', key: 'k2' }, session)

    expect(childOf(second.steps)).not.toBe(childOf(first.steps))
    expect(host.prompts).toEqual(['same', 'same'])
  })

  it('the same key over different input still returns the first row', async () => {
    // The override's whole point is that the caller owns what "the same work"
    // means; the engine stops asking. Pinned so the consequence is deliberate
    // rather than discovered — a caller keying on a partial view of its input
    // will be handed the earlier output.
    const host = makeHost()
    const session = 'one-session'

    const first = await host.run({ prompt: 'first prompt', key: 'fixed' }, session)
    const second = await host.run({ prompt: 'second prompt', key: 'fixed' }, session)

    expect(childOf(second.steps)).toBe(childOf(first.steps))
    expect(host.prompts).toEqual(['first prompt'])
  })
})
