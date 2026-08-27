// `appliesWhen: { kind: 'preserves-required' }` is the one AlternativeAppliesWhen
// member keyed on the caller rather than the catalog: it matches when the
// dispatch input carries `requiresSemantics` overlapping the alternative's
// declared `semantics`. core/alternative.ts documents the field as a
// convention, and the runtime reads it off `JobSpec.input` at dispatch. This
// file pins what that actually means:
//
//  • The match rule is overlap — `semantics.some((s) => requested.includes(s))`
//    in alternatives.ts — so one shared dimension is enough, and a dimension
//    the alternative declares but the caller did not ask for does not block it.
//  • It is consulted only once the primary path has failed: the capability is
//    unsatisfiable, or every model was exhausted. A satisfiable primary runs
//    even when the caller requires semantics. The member decides WHICH declared
//    path applies; it never pre-empts a working primary.
//  • The field is convention, not schema: a missing or malformed value means
//    "nothing required", never a throw.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  JobEvent,
  Modality,
  ModelCapability,
  PatternRegistry as PatternRegistryType,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  PatternRegistry,
  whenPreservesRequired,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })

function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    exposure: 'agent-tool',
    outputs: TEXT_OUTPUT,
    primary: {
      tool: {
        description: id,
        // The convention: a Pattern that wants `preserves-required` exposes
        // the field on its inputs. The runtime reads it regardless — this is
        // documentation for the caller, not a gate the runtime enforces.
        inputs: z.object({
          prompt: z.string(),
          requiresSemantics: z.array(z.string()).optional(),
        }),
      },
    },
  } as unknown as AtomicPattern
}

function model(
  name: string,
  calls: string[],
  behaviour: 'ok' | 'throw' = 'ok',
): ModelCapability {
  return {
    modelId: name,
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      calls.push(name)
      if (behaviour === 'throw') {
        throw Object.assign(new Error('provider 500'), {
          code: 'PROVIDER_FAILED',
        })
      }
      return { output: { modality: 'text', text: `via-${name}` } }
    },
  } as unknown as ModelCapability
}

type PrimaryState = 'unsatisfiable' | 'ok' | 'throws'

/**
 * `identity_cap` is always served. `parent_cap` is whatever the test says:
 * absent from the catalog, served by a model that answers, or served by a
 * model whose call fails. The router honours excludeModel so the fallback
 * walk stops after the one failing candidate instead of re-resolving it.
 */
function makeRouter(calls: string[], primary: PrimaryState): CapabilityRouter {
  const identity = model('identity_cap', calls)
  const parent =
    primary === 'unsatisfiable'
      ? null
      : model('parent_cap', calls, primary === 'throws' ? 'throw' : 'ok')
  return {
    checkSatisfiable: (cap) => {
      if (cap !== 'parent_cap') return { ok: true, candidates: [identity] }
      return parent
        ? { ok: true, candidates: [parent] }
        : { ok: false, reason: 'no-model-in-catalog', candidates: [] }
    },
    resolve: (cap, _tags, ctx) => {
      if (cap !== 'parent_cap') return identity
      if (!parent) {
        throw Object.assign(new Error('NO_MODEL_FOR_CAPABILITY: parent_cap'), {
          code: 'NO_MODEL_FOR_CAPABILITY',
        })
      }
      if (ctx?.excludeModel?.includes('fake:parent_cap')) {
        throw Object.assign(new Error('MODEL_EXCLUDED: fake:parent_cap'), {
          code: 'MODEL_EXCLUDED',
        })
      }
      return parent
    },
  }
}

/**
 * parent_cap with exactly one alternative, gated on the caller requiring
 * subject identity or composition. Two declared dimensions on purpose: the
 * overlap tests below check that requesting only one of them is enough.
 */
function makeRegistry(): PatternRegistryType {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.add({
    ...atomic('parent_cap'),
    alternatives: [
      {
        id: 'via-identity',
        description: 'route through the identity-preserving capability',
        appliesWhen: whenPreservesRequired('subject-identity', 'composition'),
        preserves: ['subject-identity', 'composition'],
        losses: ['style'],
        via: {
          patternId: 'identity_cap',
          mapInput: (input: unknown) => input,
          mapOutput: (output: unknown) => output,
        },
      },
    ],
  } as never)
  registry.register(atomic('identity_cap'))
  return registry
}

type Harness = {
  rt: InlineRuntime
  events: JobEvent[]
  calls: string[]
  jobIds: string[]
}

function harness(init: {
  primary: PrimaryState
  alternatives?: 'auto' | 'off'
}): Harness {
  const calls: string[] = []
  const events: JobEvent[] = []
  const jobIds: string[] = []
  const rt = new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry: makeRegistry(),
    router: makeRouter(calls, init.primary),
    ...(init.alternatives ? { alternatives: init.alternatives } : {}),
    onJobCreated: (jobId) => {
      jobIds.push(jobId)
      rt.subscribe(jobId, (ev) => events.push(ev))
    },
  })
  return { rt, events, calls, jobIds }
}

function submit(rt: InlineRuntime, input: Record<string, unknown>) {
  return rt.submitJob({ patternId: 'parent_cap', input: { prompt: 'go', ...input } })
}

function selectedIds(events: readonly JobEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'job:alternative-selected' ? [e.alternativeId] : [],
  )
}

describe("preserves-required alternatives under alternatives: 'auto'", () => {
  it('redirects when the caller requires one of the declared semantics and the primary is unsatisfiable', async () => {
    const { rt, events, calls } = harness({
      primary: 'unsatisfiable',
      alternatives: 'auto',
    })

    // Only one of the two declared dimensions is requested — overlap is the
    // rule, not coverage of everything the alternative names.
    const job = await submit(rt, { requiresSemantics: ['subject-identity'] })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-identity_cap' })
    expect(calls).toEqual(['identity_cap'])

    const selected = events.filter((e) => e.type === 'job:alternative-selected')
    expect(selected).toHaveLength(1)
    const ev = selected[0]!
    if (ev.type !== 'job:alternative-selected') throw new Error('unreachable')
    expect(ev.alternativeId).toBe('via-identity')
    expect(ev.targetPatternId).toBe('identity_cap')
    expect(ev.preserves).toEqual(['subject-identity', 'composition'])
    expect(ev.losses).toEqual(['style'])
  })

  it('does not match when none of the required semantics are declared (overlap rule, requiresSemantics: [style])', async () => {
    const { rt, events, calls, jobIds } = harness({
      primary: 'unsatisfiable',
      alternatives: 'auto',
    })

    // 'style' is what the path LOSES, not what it preserves — no overlap with
    // the declared `semantics`, so the row is not a candidate and the
    // unsatisfiable primary is the whole story.
    const failed = await submit(rt, { requiresSemantics: ['style'] })
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toMatch(/NO_MODEL_FOR_CAPABILITY/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('NO_MODEL_FOR_CAPABILITY')
    expect(calls).toEqual([])
    expect(selectedIds(events)).toEqual([])
  })

  it('is not applicable when the caller requires nothing', async () => {
    const { rt, events, calls, jobIds } = harness({
      primary: 'unsatisfiable',
      alternatives: 'auto',
    })

    const failed = await submit(rt, {})
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toMatch(/NO_MODEL_FOR_CAPABILITY/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('NO_MODEL_FOR_CAPABILITY')
    expect(calls).toEqual([])
    expect(selectedIds(events)).toEqual([])
  })

  it('never pre-empts a satisfiable primary: requiring semantics still runs the primary', async () => {
    // The Alternative JSDoc says appliesWhen is "evaluated proactively before
    // dispatching". Proactive means before any model call — not before the
    // satisfiability check. Alternatives are reached only when that check
    // fails or every model is exhausted, so a working primary is never
    // redirected on the strength of requiresSemantics alone.
    const { rt, events, calls } = harness({
      primary: 'ok',
      alternatives: 'auto',
    })

    const job = await submit(rt, { requiresSemantics: ['subject-identity'] })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-parent_cap' })
    expect(calls).toEqual(['parent_cap'])
    expect(selectedIds(events)).toEqual([])
  })

  it('is also consulted after the model wall: a failed primary call redirects when semantics are required', async () => {
    // The second pickAlternative site in inline.ts — the router resolved a
    // model, its call failed, the fallback walk ran dry. Same input field,
    // same rule.
    const { rt, events, calls } = harness({
      primary: 'throws',
      alternatives: 'auto',
    })

    const job = await submit(rt, { requiresSemantics: ['composition'] })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-identity_cap' })
    expect(calls).toEqual(['parent_cap', 'identity_cap'])
    expect(selectedIds(events)).toEqual(['via-identity'])
  })

  it('after the model wall, no required semantics means the provider error surfaces unmasked', async () => {
    const { rt, events, calls, jobIds } = harness({
      primary: 'throws',
      alternatives: 'auto',
    })

    const failed = await submit(rt, {})
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toContain('provider 500')

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('PROVIDER_FAILED')
    expect(calls).toEqual(['parent_cap'])
    expect(selectedIds(events)).toEqual([])
  })
})

describe("preserves-required alternatives under the default alternatives: 'off'", () => {
  it('runs a satisfiable primary normally with requiresSemantics set', async () => {
    // The member is about which alternative applies, not about forcing a
    // redirect when redirects are off — and not even when they are on, per
    // the 'auto' case above.
    const { rt, events, calls } = harness({ primary: 'ok' })

    const job = await submit(rt, { requiresSemantics: ['subject-identity'] })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'via-parent_cap' })
    expect(calls).toEqual(['parent_cap'])
    expect(selectedIds(events)).toEqual([])
  })

  it('names the preserves-required path on ALTERNATIVES_NOT_ENABLED when the primary is unsatisfiable', async () => {
    // The third consumer of the field: applicableAlternatives, which builds
    // the "paths not taken" report. It has to see the same value the 'auto'
    // picker sees, or the report advertises a path that would never fire.
    const { rt, events, calls, jobIds } = harness({ primary: 'unsatisfiable' })

    const failed = await submit(rt, { requiresSemantics: ['subject-identity'] })
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toMatch(/ALTERNATIVES_NOT_ENABLED/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('ALTERNATIVES_NOT_ENABLED')
    const diagnostic = (job.error!.details as {
      diagnostic: { alternatives: readonly { id: string; targetPatternId: string }[] }
    }).diagnostic
    expect(diagnostic.alternatives).toEqual([
      {
        id: 'via-identity',
        description: 'route through the identity-preserving capability',
        targetPatternId: 'identity_cap',
        // The refusal carries the trade-off, not just the path.
        preserves: ['subject-identity', 'composition'],
        losses: ['style'],
      },
    ])
    expect(calls).toEqual([])
    expect(selectedIds(events)).toEqual([])
  })

  it('does not advertise the path when nothing is required — the router error stands', async () => {
    const { rt, jobIds } = harness({ primary: 'unsatisfiable' })

    const failed = await submit(rt, {})
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toMatch(/NO_MODEL_FOR_CAPABILITY/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('NO_MODEL_FOR_CAPABILITY')
  })
})

describe('requiresSemantics is read defensively', () => {
  // The field is by-convention, so it may reach the runtime in shapes the
  // Pattern's own schema never promised. None of these may throw; a value
  // that is not an array of strings is treated as "nothing required".
  it.each([
    { label: 'a bare string', value: 'subject-identity' },
    { label: 'an object', value: { subject: 'identity' } },
    { label: 'null', value: null },
    { label: 'a number', value: 42 },
    { label: 'an array with no string entries', value: [42, null, {}] },
  ])('treats $label as nothing required', async ({ value }) => {
    const { rt, events, calls, jobIds } = harness({
      primary: 'unsatisfiable',
      alternatives: 'auto',
    })

    const failed = await submit(rt, { requiresSemantics: value })
    expect(failed.status).toBe('error')
    expect(failed.error?.message).toMatch(/NO_MODEL_FOR_CAPABILITY/)

    const job = await rt.pollJob(jobIds[0]!)
    expect(job.error!.code).toBe('NO_MODEL_FOR_CAPABILITY')
    expect(calls).toEqual([])
    expect(selectedIds(events)).toEqual([])
  })

  it('drops non-string entries and matches on the strings that remain', async () => {
    const { rt, events, calls } = harness({
      primary: 'unsatisfiable',
      alternatives: 'auto',
    })

    const job = await submit(rt, {
      requiresSemantics: [42, null, 'subject-identity', { kind: 'x' }],
    })

    expect(job.status).toBe('done')
    expect(calls).toEqual(['identity_cap'])
    expect(selectedIds(events)).toEqual(['via-identity'])
  })
})
