// The plan interpreter, over the real engine.
//
// Every claim here is a claim about `runPlan` PLUS the runtime it runs on — a
// level really runs concurrently, an untouched step really keeps its JobStore
// row, a failing step's own code really reaches the plan's job row — so the
// runtime, the store and the router are the real ones and only the four model
// envelopes are mocked (helpers/plan-host.ts).
//
// The two worked examples from docs/plan.md are the fixtures: the red bicycle
// (one-shot, `meta_plan`, DAG as input) and three-takes-judge-winner (a
// persisted-shape plan built with `planToMeta`, `$input` bound to its own
// parameter schema).

import {
  auditOutputsSchema,
  InMemoryJobStore,
  toJsonSchema,
  type PatternId,
} from '@orchestral/core'
import {
  createPlanMeta,
  planToMeta,
  PlanDagSchema,
  PlanOutputSchema,
  PLAN_PATTERN_ID,
  PLAN_TOOL_DESCRIPTION,
  type PlanDag,
  type PlanOutput,
} from '@orchestral/plan'
import { deriveIdempotencyKey } from '@orchestral/runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makePlanHost, type PlanHost } from './helpers/plan-host'

// ── fixtures ────────────────────────────────────────────────────────────

const DESCRIBE_SYSTEM =
  'You are a cinematographer. Turn the subject into one line describing a single ' +
  'still shot: framing, light, lens. No preamble.'

/** Worked example 1, in the one-shot form: no `$input`, literal prompts. */
function bicycle(motion = 'slow pan'): PlanDag {
  return {
    description: 'Describe, render and animate one short clip.',
    steps: [
      {
        id: 'describe',
        pattern: 'text-generation',
        input: { system: DESCRIBE_SYSTEM, prompt: 'a red bicycle' },
      },
      { id: 'render', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
      {
        id: 'animate',
        pattern: 'image-to-video',
        input: { prompt: motion },
        assets: { startFrame: '$render.assets[0]' },
      },
    ],
    output: {
      assets: [{ from: '$animate.assets[0]', label: 'clip' }],
      values: { description: '$describe.text' },
    },
  }
}

/** Worked example 2, verbatim — the fan-out, the judge and the winner. */
const THREE_TAKES: PlanDag = {
  steps: [
    { id: 'take-0', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    { id: 'take-1', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    { id: 'take-2', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    {
      id: 'judge',
      pattern: 'image-to-text',
      input: {
        prompt:
          'Images 0-2 are candidates for one prompt. Reply with the index of the ' +
          'strongest and one sentence why.',
      },
      assets: {
        source: ['$take-0.assets[0]', '$take-1.assets[0]', '$take-2.assets[0]'],
      },
    },
    {
      id: 'hero',
      pattern: 'meta_image-best-of-n',
      input: {
        innerPatternId: 'text-to-image',
        innerInput: { prompt: '$input.prompt' },
        n: 3,
        targetDescription: '$input.prompt',
      },
    },
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: 'slow push-in' },
      assets: { startFrame: '$hero.assets[label=winner]' },
    },
  ],
  output: {
    assets: [
      { from: '$take-0.assets[0]', label: 'take-0' },
      { from: '$take-1.assets[0]', label: 'take-1' },
      { from: '$take-2.assets[0]', label: 'take-2' },
      { from: '$hero.assets[label=winner]', label: 'hero' },
      { from: '$animate.assets[0]', label: 'clip' },
    ],
    values: { verdict: '$judge.text' },
  },
}

const JUDGE_PROMPT = THREE_TAKES.steps[3]?.input.prompt as string

/** `meta_plan`, wired to a host's registry through the `getPattern` op. */
function planMetaFor(host: Pick<PlanHost, 'registry'>) {
  return createPlanMeta({ getPattern: (id) => host.registry.get(id) })
}

/** A host with the one-shot registered on top of the four atomics. */
function hostWithPlanMeta(store?: InMemoryJobStore, latencyMs?: number): PlanHost {
  const registryHolder = makePlanHost({
    ...(store !== undefined ? { store } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  })
  registryHolder.registry.add(planMetaFor(registryHolder))
  return registryHolder
}

// ── worked example 1 ────────────────────────────────────────────────────

describe('meta_plan — the red bicycle, end to end', () => {
  it('runs three steps in dependency order and returns the declared envelope', async () => {
    const host = hostWithPlanMeta()
    const run = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), 'session-1')

    expect(run.job.error).toBeNull()
    expect(run.job.status).toBe('done')

    // The output is the fixed envelope — parsed, not eyeballed. The runtime
    // already gated it (OUTPUT_SCHEMA_MISMATCH); this proves the shape the test
    // reads below is the schema's, not a coincidence.
    const out = PlanOutputSchema.parse(run.job.output)
    expect(out.values.description).toBe(
      'Still of a red bicycle: centred in frame, soft morning light.',
    )
    expect(out.assets).toHaveLength(1)
    expect(out.assets[0]).toMatchObject({ label: 'clip', modality: 'video' })
    expect(out.assets[0]?.assetId).toMatch(/^clip-/)
    // `steps[]` carries no assetId / url / childJobId — every produced id is
    // inside `assets[]` and nowhere else.
    expect(out.steps).toEqual([
      { id: 'describe', pattern: 'text-generation', cost: 0.01 },
      { id: 'render', pattern: 'text-to-image', cost: 0.02 },
      { id: 'animate', pattern: 'image-to-video', cost: 0.03 },
    ])
    expect(out.cost).toBeCloseTo(0.06, 10)
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // One `job:step` per plan step, under the author's own ids.
    expect(run.steps.map((s) => s.stepId)).toEqual(['describe', 'render', 'animate'])
    expect(run.steps.map((s) => s.patternId)).toEqual([
      'text-generation',
      'text-to-image',
      'image-to-video',
    ])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it("substitution reads the producer's stored output, and the asset channel carries the still", async () => {
    const host = hostWithPlanMeta()
    const run = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), 'session-2')
    const out = PlanOutputSchema.parse(run.job.output)

    // `render`'s prompt is `describe`'s text verbatim — the ref resolved
    // against the stored output, not against the literal string.
    const renderRow = await host.runtime.pollJob(run.steps[1]?.childJobId ?? '')
    expect(renderRow?.input).toEqual({ prompt: out.values.description })

    // The still reached `animate` through PatternRef.assets, never through
    // `input` — the machine-to-machine channel, slot-keyed, landing in the
    // adapter's own DispatchContext.assets.
    const animateRow = await host.runtime.pollJob(run.steps[2]?.childJobId ?? '')
    expect(animateRow?.input).toEqual({ prompt: 'slow pan' })
    const ctx = host.calls.imageToVideo.mock.calls[0]?.[1] as {
      assets?: readonly { slot: string; assetId: string; modality: string }[]
    }
    expect(ctx.assets).toEqual([
      {
        slot: 'startFrame',
        assetId: run.steps[1]?.assetIds[0],
        modality: 'image',
      },
    ])
  })
})

// ── worked example 2 ────────────────────────────────────────────────────

describe('planToMeta — three takes, a judge, and a winner', () => {
  const shortlist = () =>
    planToMeta(THREE_TAKES, {
      id: 'meta_shortlist' as PatternId,
      lookup: { get: () => undefined, getEntry: () => undefined },
      inputs: z.object({ prompt: z.string().min(1).max(2000) }),
      exposure: 'tool',
      description: 'Render three takes, judge them, animate the best-of-n winner.',
    })

  function host(): PlanHost {
    const h = makePlanHost({ bestOfN: true, latencyMs: 5 })
    h.registry.add(
      planToMeta(THREE_TAKES, {
        id: 'meta_shortlist' as PatternId,
        lookup: h.registry,
        inputs: z.object({ prompt: z.string().min(1).max(2000) }),
        exposure: 'tool',
        description: 'Render three takes, judge them, animate the best-of-n winner.',
      }),
    )
    return h
  }

  it('returns every declared asset under its label and the judge’s verdict', async () => {
    const h = host()
    const run = await h.run<PlanOutput>(
      'meta_shortlist' as PatternId,
      { prompt: 'a red bicycle' },
      'session-takes',
    )
    expect(run.job.error).toBeNull()
    const out = PlanOutputSchema.parse(run.job.output)

    expect(out.assets.map((a) => a.label)).toEqual([
      'take-0',
      'take-1',
      'take-2',
      'hero',
      'clip',
    ])
    expect(out.values.verdict).toContain('Take 0 is the strongest')
    // `[label=winner]` resolved through the REAL meta_image-best-of-n, whose
    // compose stamps `winner` on the chosen candidate. The animated clip is
    // therefore the winner's, not take-0's.
    const hero = out.assets.find((a) => a.label === 'hero')
    const takes = out.assets.filter((a) => a.label.startsWith('take-'))
    expect(hero?.modality).toBe('image')
    expect(takes.map((t) => t.assetId)).not.toContain(hero?.assetId)

    expect(h.calls.textToImage).toHaveBeenCalledTimes(6) // 3 takes + 3 candidates
    expect(h.calls.imageToText).toHaveBeenCalledTimes(2) // the plan's judge + best-of-n's
    expect(h.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it('a level runs concurrently: every take is dispatched before the judge', async () => {
    const h = host()
    await h.run<PlanOutput>(
      'meta_shortlist' as PatternId,
      { prompt: 'a red bicycle' },
      'session-concurrency',
    )
    const enters = h.models.trace.filter((e) => e.phase === 'enter')
    const judgeAt = enters.findIndex(
      (e) => e.capability === 'image-to-text' && e.prompt === JUDGE_PROMPT,
    )
    expect(judgeAt).toBeGreaterThan(-1)
    // `judge` sits on level 1; every render in the plan — the three takes and
    // best-of-n's three candidates — sits on level 0 and is therefore already
    // in flight before it.
    const rendersFirst = enters
      .slice(0, judgeAt)
      .filter((e) => e.capability === 'text-to-image')
    expect(rendersFirst).toHaveLength(6)
    // Overlap, not merely order: the level's steps were CALLED before any of
    // them was awaited, so more than one render was live at once.
    expect(h.models.peak['text-to-image']).toBeGreaterThanOrEqual(3)
  })

  it('identical fan-out steps get distinct rows — a plan keys its steps by id', async () => {
    const h = host()
    const run = await h.run<PlanOutput>(
      'meta_shortlist' as PatternId,
      { prompt: 'a red bicycle' },
      'session-fanout',
    )
    const takes = run.steps.filter((s) => s.stepId.startsWith('take-'))
    // take-0..2 have byte-identical patternId and input; under positional
    // identity they would still differ, but under `identity: 'id'` it is the
    // stepKey that separates them — and that is what survives an edit.
    expect(takes).toHaveLength(3)
    expect(new Set(takes.map((s) => s.childJobId)).size).toBe(3)
  })

  it('declares its whole static dispatch set for the agent guard', () => {
    expect(shortlist().plannedDispatches?.({})).toEqual([
      'text-to-image',
      'text-to-image',
      'text-to-image',
      'image-to-text',
      'meta_image-best-of-n',
      'image-to-video',
    ])
  })
})

// ── identity: 'id' — the payoff ─────────────────────────────────────────

describe('meta_plan — re-run after inserting an independent step', () => {
  it('keeps the child job ids of every step whose input did not change', async () => {
    const host = hostWithPlanMeta()
    const session = 'session-insert'

    const run1 = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), session)
    expect(run1.job.status).toBe('done')
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)

    // Run 2 inserts `caption` SECOND — an independent branch read only by
    // `output.values`. Under positional identity this would move `render` from
    // index 1 to 2 and `animate` from 2 to 3, re-running both for nothing.
    const edited = bicycle()
    edited.steps.splice(1, 0, {
      id: 'caption',
      pattern: 'text-generation',
      input: { prompt: 'One line of alt text for a red bicycle.' },
    })
    ;(edited.output.values as Record<string, string>).caption = '$caption.text'

    const run2 = await host.run<PlanOutput>(PLAN_PATTERN_ID, edited, session)
    expect(run2.job.status).toBe('done')
    expect(run2.job.id).not.toBe(run1.job.id) // the DAG is the plan's own input

    const idOf = (trace: typeof run1, stepId: string) =>
      trace.steps.find((s) => s.stepId === stepId)?.childJobId
    expect(idOf(run2, 'describe')).toBe(idOf(run1, 'describe'))
    expect(idOf(run2, 'render')).toBe(idOf(run1, 'render'))
    expect(idOf(run2, 'animate')).toBe(idOf(run1, 'animate'))
    expect(idOf(run2, 'caption')).toBeDefined()

    // One model call for one new step: the plan row and the caption row.
    expect(run2.inserted).toEqual([PLAN_PATTERN_ID, 'text-generation'])
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(2)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(1)
  })

  it('each child row is keyed on the stepKey, never on the counter position', async () => {
    const host = hostWithPlanMeta()
    const session = 'session-key'
    const run = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), session)
    const out = PlanOutputSchema.parse(run.job.output)
    const rowOf = async (stepId: string) =>
      host.runtime.pollJob(
        run.steps.find((s) => s.stepId === stepId)?.childJobId ?? '',
      )

    // The input in the key is what the plan WROTE, substituted — no defaults.
    // A zod copy would carry maxOutputTokens: 2048 / temperature: 0.7 here and
    // key this step differently from a hand-written meta with the same prompt.
    expect((await rowOf('describe'))?.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-generation',
        input: { system: DESCRIBE_SYSTEM, prompt: 'a red bicycle' },
        sessionId: session,
        stepKey: 'describe',
      }),
    )
    expect((await rowOf('render'))?.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'text-to-image',
        input: { prompt: out.values.description },
        sessionId: session,
        stepKey: 'render',
      }),
    )
    expect((await rowOf('animate'))?.idempotencyKey).toBe(
      deriveIdempotencyKey({
        patternId: 'image-to-video',
        input: { prompt: 'slow pan' },
        assets: [
          {
            slot: 'startFrame',
            assetId: run.steps.find((s) => s.stepId === 'render')?.assetIds[0] ?? '',
            modality: 'image',
          },
        ],
        sessionId: session,
        stepKey: 'animate',
      }),
    )
  })

  it('a changed motion re-keys only animate', async () => {
    const host = hostWithPlanMeta()
    const session = 'session-motion'
    const run1 = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), session)
    const run2 = await host.run<PlanOutput>(
      PLAN_PATTERN_ID,
      bicycle('orbit'),
      session,
    )
    expect(run2.steps[0]?.childJobId).toBe(run1.steps[0]?.childJobId)
    expect(run2.steps[1]?.childJobId).toBe(run1.steps[1]?.childJobId)
    expect(run2.steps[2]?.childJobId).not.toBe(run1.steps[2]?.childJobId)
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    expect(host.calls.textToImage).toHaveBeenCalledTimes(1)
    expect(host.calls.imageToVideo).toHaveBeenCalledTimes(2)
  })
})

// ── failure ─────────────────────────────────────────────────────────────

describe('meta_plan — a failing step', () => {
  it("fails the plan job with the CHILD's own code and names the step", async () => {
    const host = hostWithPlanMeta()
    host.calls.textToImage.mockRejectedValueOnce(
      Object.assign(new Error('the renderer fell over'), {
        code: 'MOCK_PROVIDER_BLIP',
      }),
    )
    const run = await host.run<PlanOutput>(
      PLAN_PATTERN_ID,
      bicycle(),
      'session-fail',
    )

    expect(run.job.status).toBe('error')
    // The innermost code, not a wrapper: the interpreter rethrows the SAME
    // object it caught, having stamped which step it belonged to.
    expect(run.job.error?.code).toBe('MOCK_PROVIDER_BLIP')
    expect(run.job.error?.message).toContain('the renderer fell over')
    expect(run.job.error?.details).toMatchObject({
      planStepId: 'render',
      planPatternId: PLAN_PATTERN_ID,
    })

    // No partial-success state: the step that succeeded is a row in the store,
    // and the next submit hits it.
    expect(host.calls.imageToVideo).not.toHaveBeenCalled()
    const retry = await host.run<PlanOutput>(
      PLAN_PATTERN_ID,
      bicycle(),
      'session-fail',
    )
    expect(retry.job.status).toBe('done')
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1) // describe hit
    expect(host.calls.textToImage).toHaveBeenCalledTimes(2) // the blip, the retry
  })

  it('refuses to read a step that deduped onto a row still in flight', async () => {
    const store = new InMemoryJobStore()
    const host = hostWithPlanMeta(store)
    const session = 'session-inflight'

    // Seed the store with a `queued` row under exactly the key `describe` will
    // derive. `insertIfAbsent` returns it without awaiting it, and `ctx.step`
    // hands its `null` output to compose.
    await store.insert({
      id: 'pretend-in-flight',
      patternId: 'text-generation' as PatternId,
      input: { system: DESCRIBE_SYSTEM, prompt: 'a red bicycle' },
      status: 'queued',
      output: null,
      error: null,
      sessionId: session,
      idempotencyKey: deriveIdempotencyKey({
        patternId: 'text-generation',
        input: { system: DESCRIBE_SYSTEM, prompt: 'a red bicycle' },
        sessionId: session,
        stepKey: 'describe',
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    const run = await host.run<PlanOutput>(PLAN_PATTERN_ID, bicycle(), session)
    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_STEP_IN_FLIGHT')
    expect(run.job.error?.details).toMatchObject({ planStepId: 'describe' })
    // Nothing downstream of it ran: `null` never reached render's prompt.
    expect(host.calls.textToImage).not.toHaveBeenCalled()
  })
})

// ── layer 2 ─────────────────────────────────────────────────────────────

describe('meta_plan — the layer-2 gate', () => {
  /** A ref into a NUMERIC field: legal at layer 1 (the type only exists after
   *  substitution), refused at layer 2 once it resolves to a string. */
  function mistyped(): PlanDag {
    return {
      steps: [
        {
          id: 'describe',
          pattern: 'text-generation',
          input: { prompt: 'a red bicycle' },
        },
        {
          id: 'expand',
          pattern: 'text-generation',
          input: { prompt: 'expand it', maxOutputTokens: '$describe.text' },
        },
      ],
      output: { values: { long: '$expand.text' } },
    }
  }

  it('rejects a mistyped substituted input BEFORE the step is dispatched', async () => {
    const host = hostWithPlanMeta()
    // Layer 1 lets it through: rule 21 suppresses issues landing on a
    // ref-valued field, because that field has no type until substitution.
    expect(PlanDagSchema.safeParse(mistyped()).success).toBe(true)

    const run = await host.run<PlanOutput>(
      PLAN_PATTERN_ID,
      mistyped(),
      'session-gate',
    )
    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_STEP_INPUT_INVALID')
    expect(run.job.error?.details).toMatchObject({
      planStepId: 'expand',
      patternId: 'text-generation',
    })
    // `describe` ran (the gate is per step, after its own upstream); `expand`
    // never reached a model.
    expect(host.calls.textGeneration).toHaveBeenCalledTimes(1)
    const rows = await host.store.query({ patternId: 'text-generation' as PatternId })
    expect(rows).toHaveLength(1)
  })

  it('dispatches the input as written, never zod’s defaults-applied copy', async () => {
    const host = hostWithPlanMeta()
    const run = await host.run<PlanOutput>(
      PLAN_PATTERN_ID,
      bicycle(),
      'session-original',
    )
    const describeRow = await host.runtime.pollJob(run.steps[0]?.childJobId ?? '')
    // text-generation's schema defaults maxOutputTokens: 2048, temperature: 0.7
    // and responseFormat: 'text'. None of them is here: the gate parsed a copy
    // and threw it away.
    expect(describeRow?.input).toEqual({
      system: DESCRIBE_SYSTEM,
      prompt: 'a red bicycle',
    })
    // And the object the adapter saw is the one the interpreter built — same
    // identity, not a structural twin.
    const seen = host.calls.textGeneration.mock.calls[0]?.[0]
    expect(seen).toBe(describeRow?.input)
  })
})

// ── layer 1, inside compose ─────────────────────────────────────────────

describe('meta_plan — PLAN_INVALID from compose', () => {
  it('lists every problem at once and dispatches nothing', async () => {
    const host = hostWithPlanMeta()
    // Three problems, three different remedies, all in one DAG: `describe`
    // reads a step listed after it AND is read by nothing, and `render` names a
    // pattern the registry does not have.
    const dag: PlanDag = {
      steps: [
        {
          id: 'describe',
          pattern: 'text-generation',
          input: { prompt: '$animate.text' },
        },
        { id: 'render', pattern: 'text-to-hologram', input: { prompt: 'a bicycle' } },
        {
          id: 'animate',
          pattern: 'image-to-video',
          input: { prompt: 'slow pan' },
          assets: { startFrame: '$render.assets[0]' },
        },
      ],
      output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
    }

    const run = await host.run<PlanOutput>(PLAN_PATTERN_ID, dag, 'session-invalid')
    expect(run.job.status).toBe('error')
    expect(run.job.error?.code).toBe('PLAN_INVALID')

    const problems = (
      run.job.error?.details as { problems?: readonly { code: string }[] }
    )?.problems
    expect(problems?.map((p) => p.code).sort()).toEqual([
      'PLAN_PATTERN_NOT_FOUND',
      'PLAN_REF_FORWARD',
      'PLAN_STEP_UNUSED',
    ])

    // Zero spend: the walk ran before the first ctx.step, so not even
    // `describe` — which is perfectly valid — was dispatched.
    expect(host.calls.textGeneration).not.toHaveBeenCalled()
    expect(host.calls.textToImage).not.toHaveBeenCalled()
    expect(host.calls.imageToVideo).not.toHaveBeenCalled()
    expect(run.steps).toEqual([])
  })
})

// ── construction ────────────────────────────────────────────────────────

describe('planToMeta — construction time', () => {
  const noLookup = { get: () => undefined, getEntry: () => undefined }

  it('refuses an id that is not a meta', () => {
    expect(() =>
      planToMeta(bicycle(), { id: 'short-clip' as PatternId, lookup: noLookup }),
    ).toThrow(/PLAN_ID_INVALID/)
  })

  it('throws PlanInvalidError for the registry-FREE problems', () => {
    const dag = bicycle()
    dag.steps[1] = {
      id: 'render',
      pattern: 'text-to-image',
      input: { prompt: '$animate.text' },
    }
    expect(() =>
      planToMeta(dag, { id: 'meta_broken' as PatternId, lookup: noLookup }),
    ).toThrow(/PLAN_INVALID/)
  })

  it('leaves the registry rules for compose — a factory runs before registration', () => {
    // `text-generation` is not in this lookup, and construction still succeeds:
    // `addFromManifest` builds every pattern in a package before it registers
    // any of them, so a factory that demanded a populated registry could never
    // be loaded from a manifest at all.
    const pattern = planToMeta(bicycle(), {
      id: 'meta_late' as PatternId,
      lookup: noLookup,
    })
    expect(pattern.origin).toBe('plan')
    expect(pattern.exposure).toBe('no-tool') // the default: not another loop's tool
  })

  it('carries the DAG on the pattern so preflight can expand it', () => {
    const dag = bicycle()
    const pattern = planToMeta(dag, {
      id: 'meta_carried' as PatternId,
      lookup: noLookup,
    })
    expect(pattern.plan).toBe(dag)
    expect(pattern.kind).toBe('meta')
  })
})

// ── the shipped one-shot's surface ──────────────────────────────────────

describe('meta_plan — the registered pattern', () => {
  const meta = createPlanMeta({ getPattern: () => undefined })

  it('passes auditOutputsSchema with nothing unbounded and nothing unaudited', () => {
    expect(auditOutputsSchema(meta.outputs)).toEqual({
      unbounded: [],
      notTraversed: [],
    })
  })

  it('renders to JSON Schema, and the refine is invisible to the renderer', () => {
    const rendered = toJsonSchema(meta.tool.inputs)
    expect(rendered).toBeDefined()
    // A `.superRefine` contributes nothing to the rendered shape — which is
    // exactly why the graph rules are also spelled out in `.describe()` copy
    // and in the tool description.
    expect(rendered).toEqual(toJsonSchema(PlanDagSchema))
  })

  it('is a deferred tool in the meta-pipelines namespace, authored from data', () => {
    expect(meta.id).toBe(PLAN_PATTERN_ID)
    expect(meta.origin).toBe('plan')
    expect(meta.exposure).toBe('tool')
    expect(meta.exposureMode).toBe('deferred')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.tool.description).toBe(PLAN_TOOL_DESCRIPTION)
    // The searchHint names no atomic capability: it is a boost-5.0 field, and
    // "text-to-image" in it would put meta_plan into every atomic query's top
    // five.
    expect(meta.searchHint).not.toMatch(/text-to-image|image-to-video/)
  })

  it('declares the dispatch set an agent guard holds to its allowlist', () => {
    expect(meta.plannedDispatches?.(bicycle())).toEqual([
      'text-generation',
      'text-to-image',
      'image-to-video',
    ])
    // Reads defensively: it runs on the dispatch path, and host-direct submit
    // never parses the input against `tool.inputs`.
    expect(meta.plannedDispatches?.({} as PlanDag)).toEqual([])
  })
})
