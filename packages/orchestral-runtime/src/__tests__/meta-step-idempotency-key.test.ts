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

function createFakeGenPattern(
  id = 'fake-gen',
): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id,
    kind: 'atomic',
    description: 'fake generator for the step idempotency-key test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

/**
 * Two steps under ONE caller-supplied key, deliberately naming two different
 * patterns — the collision the derivation could never produce, because it
 * hashes `patternId`.
 */
function createCrossPatternMeta(): MetaPattern<KeyedInput, unknown> {
  return {
    id: 'meta_cross',
    kind: 'meta',
    description: 'two patterns, one caller-supplied key',
    outputs: z.any() as never,
    tool: { description: 'cross', inputs: z.any() as never },
    async compose({ input }, ctx) {
      // Absent `key`, the derivation runs — and it hashes `patternId`, which is
      // why no derived key can reach the refusal below.
      const keyed =
        input.key === undefined ? {} : { idempotencyKey: input.key }
      await ctx.step(
        { patternId: 'fake-gen', input: { prompt: input.prompt } },
        { stepId: 'a', identity: 'id', ...keyed },
      )
      return await ctx.step(
        { patternId: 'fake-gen-b', input: { prompt: input.prompt } },
        { stepId: 'b', identity: 'id', ...keyed },
      )
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
  registry.register(createFakeGenPattern('fake-gen-b') as never)
  registry.register(createKeyedMeta() as never)
  registry.register(createCrossPatternMeta() as never)

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
    async run(input: KeyedInput, sessionId: string, patternId = 'meta_keyed') {
      const sink: StepRecord[] = []
      collecting = sink
      sawRoot = false
      const before = prompts.length
      try {
        const job = await runtime.submitJob({
          patternId,
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

  it('refuses a key that collides across two patterns', async () => {
    // The one collision the engine can still call wrong on the caller's
    // behalf. "The same work" is the caller's to define, but a row filed under
    // another pattern is not a stale answer to this question — it is an answer
    // to a different one, and its output never met this pattern's schema.
    const host = makeHost()

    const run = await host.run(
      { prompt: 'a still of a hare', key: 'tenant-42:a-private-prompt-hash' },
      'session-one',
      'meta_cross',
    )

    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('IDEMPOTENCY_KEY_CROSS_PATTERN')
    expect(run.job.error?.message).toContain('fake-gen')
    expect(run.job.error?.message).toContain('fake-gen-b')
    // The key is truncated on the way out: a caller-derived key can embed host
    // data, and this message reaches a model as a tool result. Enough to
    // recognise the key, not enough to read it.
    expect(run.job.error?.message).toContain('tenant-42:a-')
    expect(run.job.error?.message).not.toContain('a-private-prompt-hash')
    // The unabridged facts are on `details`, which stays host-side.
    expect(run.job.error?.details).toMatchObject({
      patternId: 'fake-gen-b',
      heldBy: 'fake-gen',
    })
  })

  it('the same two steps unkeyed are fine: the derivation hashes patternId', async () => {
    // The refusal is reachable only through the override, which is the whole
    // argument for putting it there rather than in the derivation.
    const host = makeHost()

    const run = await host.run({ prompt: 'a hare' }, 'session-one', 'meta_cross')

    expect(run.job.status).toBe('done')
    expect(host.prompts).toEqual(['a hare', 'a hare'])
  })
})
