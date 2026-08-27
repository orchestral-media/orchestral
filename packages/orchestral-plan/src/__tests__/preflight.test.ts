// `preflightPlan` — what a plan would cost, routed but not run.
//
// The contract this pins:
//
//  • Validation first. Any problem at all and the report carries the problems
//    and nothing else — no steps, no levels, no half a plan for a host to
//    render as if it were routable.
//  • The routing decision per atomic step comes from `router.explain` when the
//    router has it and from `checkSatisfiable` when it does not. `explain` is
//    OPTIONAL on CapabilityRouter, so both shapes of router are exercised here
//    against the same DAG and both have to answer.
//  • An unsatisfiable step names the first applicable declared alternative,
//    evaluated with the same `appliesWhen` machinery the dispatch path uses,
//    and says whether it `wouldFire` — which is the runtime's `alternatives`
//    mode and nothing else, because 'off' is the default and under it the
//    dispatch fails naming the path rather than taking it.
//  • A meta is opaque. What it has declared about itself — `plannedDispatches`,
//    and its own DAG when it is a plan — is reported, and a declaration that
//    throws degrades to "not knowable" instead of taking the report down.
//  • Nothing is dispatched, no model is called, and nothing prints.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type {
  AssetNeed,
  AtomicPattern,
  Capability,
  CapabilityRouter,
  JobSpec,
  MetaPattern,
  ModelCapability,
  ModelTag,
  ResolveContext,
  SatisfiableResult,
} from '@orchestral/core'
import {
  boundedText,
  createDefaultCapabilityRouter,
  dispatchEnvelopeShape,
  PatternRegistry,
  producedAssetShape,
  silentDiagnosticsLogger,
  whenCapabilityUnavailable,
  whenPreservesRequired,
} from '@orchestral/core'

import { PlanOutputSchema, type PlanDag } from '../plan'
import { formatPlanPreflight, preflightPlan } from '../preflight'

// ── Patterns ─────────────────────────────────────────────────────────────

const TEXT_OUTPUT = z.object({
  modality: z.literal('text'),
  text: boundedText(65_536),
  ...dispatchEnvelopeShape,
})

const imageOutput = (modality: 'image' | 'video') =>
  z.object({
    modality: z.literal(modality),
    assets: z.array(z.object(producedAssetShape(modality))),
    ...dispatchEnvelopeShape,
  })

function atomic(spec: {
  id: string
  inputs: z.ZodObject
  outputs: z.ZodType
  assetNeeds?: readonly AssetNeed[]
  modelTags?: readonly ModelTag[]
}): AtomicPattern {
  return {
    id: spec.id,
    kind: 'atomic',
    description: `atomic ${spec.id}`,
    exposure: 'agent-tool',
    outputs: spec.outputs,
    ...(spec.assetNeeds ? { assetNeeds: spec.assetNeeds } : {}),
    primary: {
      tool: { description: spec.id, inputs: spec.inputs },
      ...(spec.modelTags ? { modelTags: spec.modelTags } : {}),
    },
  } as unknown as AtomicPattern
}

/** Real-shaped needs, copied from the shipped image-to-video pattern. */
const START_FRAME: readonly AssetNeed[] = [
  {
    slot: 'startFrame',
    modality: 'image',
    cardinality: 'single',
    required: true,
    description: 'The image to animate — becomes the first frame.',
  },
]

const SOURCE_IMAGE: readonly AssetNeed[] = [
  {
    slot: 'source',
    modality: 'image',
    cardinality: 'single',
    required: true,
    description: 'The image to edit.',
  },
]

/**
 * The registry every test routes against.
 *
 *   text-generation  — served, no alternatives
 *   text-to-image    — served, no alternatives
 *   image-to-video   — NOT served, one capability-unavailable alternative
 *   image-to-image   — NOT served, one preserves-required alternative
 *
 * plus the two alternative targets and the metas the opaque cases need.
 */
function makeRegistry(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })

  registry.register(
    atomic({
      id: 'text-generation',
      inputs: z.object({
        system: z.string().max(4_000).optional(),
        prompt: z.string().max(4_000),
      }),
      outputs: TEXT_OUTPUT,
    }),
  )
  registry.register(
    atomic({
      id: 'text-to-image',
      inputs: z.object({ prompt: z.string().max(4_000) }),
      outputs: imageOutput('image'),
    }),
  )
  registry.add({
    ...atomic({
      id: 'image-to-video',
      inputs: z.object({ prompt: z.string().max(4_000).optional() }),
      outputs: imageOutput('video'),
      assetNeeds: START_FRAME,
    }),
    alternatives: [
      {
        id: 'via-frames',
        description: 'render the in-between frames and concatenate them',
        appliesWhen: whenCapabilityUnavailable(),
        preserves: ['subject-identity'],
        losses: ['camera-motion'],
        via: {
          patternId: 'meta_image-to-video-via-frames',
          mapInput: (input: unknown) => input,
          mapOutput: (output: unknown) => output,
        },
      },
    ],
  } as never)
  registry.add({
    ...atomic({
      id: 'image-to-image',
      // `requiresSemantics` is deliberately NOT on this schema. The field is
      // convention, not schema — one appliesWhen member must not force a field
      // onto every Pattern that will never declare such a row — so it reaches
      // the runtime through `resolveDispatchTarget`'s top-level passthrough,
      // untyped, which is exactly why the read has to be defensive.
      inputs: z.object({ prompt: z.string().max(4_000) }),
      outputs: imageOutput('image'),
      assetNeeds: SOURCE_IMAGE,
    }),
    alternatives: [
      {
        id: 'via-identity',
        description: 'route through the identity-preserving capability',
        appliesWhen: whenPreservesRequired('subject-identity', 'composition'),
        preserves: ['subject-identity', 'composition'],
        losses: ['style'],
        via: {
          patternId: 'meta_identity-edit',
          mapInput: (input: unknown) => input,
          mapOutput: (output: unknown) => output,
        },
      },
    ],
  } as never)

  registry.register(meta({ id: 'meta_image-to-video-via-frames' }))
  registry.register(meta({ id: 'meta_identity-edit' }))
  registry.register(
    meta({
      id: 'meta_best-of-n',
      inputs: z.object({
        innerPatternId: z.string().max(128),
        n: z.number().int().min(1).max(8),
      }),
      plannedDispatches: (input: { innerPatternId: string }) => [
        input.innerPatternId,
      ],
    }),
  )
  registry.register(
    meta({
      id: 'meta_broken-declaration',
      plannedDispatches: () => {
        throw new Error('the author read the wrong field')
      },
    }),
  )
  registry.register(planMeta('meta_short-clip', SHORT_CLIP_PLAN))
  registry.register(planMeta('meta_edit-clip', EDIT_PLAN))
  return registry
}

function meta(spec: {
  id: string
  inputs?: z.ZodObject
  plannedDispatches?: (input: never) => readonly string[]
}): MetaPattern {
  return {
    id: spec.id,
    kind: 'meta',
    description: `meta ${spec.id}`,
    exposure: 'agent-tool',
    outputs: PlanOutputSchema,
    tool: {
      description: spec.id,
      inputs: spec.inputs ?? z.object({ prompt: z.string().max(4_000) }),
    },
    compose: async () => {
      throw new Error('preflight must never run compose')
    },
    ...(spec.plannedDispatches
      ? { plannedDispatches: spec.plannedDispatches }
      : {}),
  } as unknown as MetaPattern
}

/** docs/plan.md's worked example 1, in its persisted form. */
const SHORT_CLIP_PLAN: PlanDag = {
  steps: [
    {
      id: 'describe',
      pattern: 'text-generation',
      input: {
        system: 'Turn the subject into one line describing a single still shot.',
        prompt: '$input.prompt',
      },
    },
    { id: 'render', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: '$input.motion' },
      assets: { startFrame: '$render.assets[0]' },
    },
  ],
  output: {
    assets: [{ from: '$animate.assets[0]', label: 'clip' }],
    values: { description: '$describe.text' },
  },
}

/** A persisted plan whose one edit step nothing serves and nothing rescues. */
const EDIT_PLAN: PlanDag = {
  steps: [
    { id: 'seed', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    {
      id: 'edit',
      pattern: 'image-to-image',
      input: { prompt: 'make it blue' },
      assets: { source: '$seed.assets[0]' },
    },
  ],
  output: { assets: [{ from: '$edit.assets[0]', label: 'edited' }] },
}

/**
 * A persisted plan: `origin: 'plan'` plus the DAG on a `plan` field, which is
 * what the interpreter in @orchestral/patterns stamps onto what it returns and
 * what preflight recurses into. Read structurally — the runtime does not depend
 * on the interpreter's type.
 */
function planMeta(id: string, plan: PlanDag): MetaPattern {
  return {
    ...meta({
      id,
      inputs: z.object({
        prompt: z.string().max(2_000),
        motion: z.string().max(500).optional(),
      }),
      plannedDispatches: () => plan.steps.map((s) => s.pattern),
    }),
    origin: 'plan',
    plan,
  } as unknown as MetaPattern
}

// ── Routers ──────────────────────────────────────────────────────────────

const CATALOG: Record<string, readonly { provider: string; modelId: string }[]> =
  {
    'text-generation': [
      { provider: 'openai', modelId: 'gpt-4.1' },
      { provider: 'anthropic', modelId: 'claude-4' },
    ],
    'text-to-image': [{ provider: 'fal', modelId: 'flux-pro' }],
    // image-to-video and image-to-image are served by nothing on purpose.
  }

function record(
  cap: string,
  spec: { provider: string; modelId: string },
): ModelCapability {
  return {
    ...spec,
    tags: [],
    capabilities: [cap],
    inputs: ['text'],
    outputs: ['text'],
    source: 'user',
    call: () => {
      throw new Error('preflight must never call a model')
    },
  } as unknown as ModelCapability
}

/** The shipped default router. It HAS `explain`. */
function explainingRouter(): CapabilityRouter {
  return createDefaultCapabilityRouter({
    getModels: (cap) => (CATALOG[cap] ?? []).map((m) => record(cap, m)),
  })
}

/**
 * A host router written before `explain` existed: the two methods the interface
 * requires, and nothing else. Every consumer has to feature-detect, so this is
 * the shape that catches a preflight which assumed the optional member.
 */
function twoMethodRouter(): CapabilityRouter {
  const check = (cap: Capability): SatisfiableResult => {
    const models = (CATALOG[cap] ?? []).map((m) => record(cap, m))
    return models.length > 0
      ? { ok: true, candidates: models }
      : { ok: false, reason: 'no-model-in-catalog', candidates: [] }
  }
  return {
    checkSatisfiable: check,
    resolve: (cap) => {
      const sat = check(cap)
      if (!sat.ok) {
        throw Object.assign(new Error(`NO_MODEL_FOR_CAPABILITY: ${cap}`), {
          code: 'NO_MODEL_FOR_CAPABILITY',
        })
      }
      return sat.candidates[0] as ModelCapability
    },
  }
}

// ── DAGs ─────────────────────────────────────────────────────────────────

/** The same pipeline as SHORT_CLIP_PLAN, with literals where `$input` was. */
const CLIP_DAG: PlanDag = {
  description: 'Describe, render and animate one short clip.',
  steps: [
    {
      id: 'describe',
      pattern: 'text-generation',
      input: {
        system: 'Turn the subject into one line describing a single still shot.',
        prompt: 'a red bicycle',
      },
    },
    { id: 'render', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
    {
      id: 'animate',
      pattern: 'image-to-video',
      input: { prompt: 'slow push-in' },
      assets: { startFrame: '$render.assets[0]' },
    },
  ],
  output: {
    assets: [{ from: '$animate.assets[0]', label: 'clip' }],
    values: { description: '$describe.text' },
  },
}

/** Two independent roots, then a chain: levels [a, b] / [c] / [d]. */
const DIAMOND_DAG: PlanDag = {
  steps: [
    { id: 'a', pattern: 'text-generation', input: { prompt: 'first' } },
    { id: 'b', pattern: 'text-generation', input: { prompt: 'second' } },
    { id: 'c', pattern: 'text-generation', input: { prompt: '$a.text' } },
    { id: 'd', pattern: 'text-generation', input: { prompt: '$c.text' } },
  ],
  output: {
    values: { a: '$a.text', b: '$b.text', c: '$c.text', d: '$d.text' },
  },
}

/** One edit step on an unserved capability, with `requiresSemantics` filled. */
function editDag(requiresSemantics?: unknown): PlanDag {
  return {
    steps: [
      { id: 'seed', pattern: 'text-to-image', input: { prompt: 'a red bicycle' } },
      {
        id: 'edit',
        pattern: 'image-to-image',
        input: {
          prompt: 'make it blue',
          ...(requiresSemantics !== undefined ? { requiresSemantics } : {}),
        },
        assets: { source: '$seed.assets[0]' },
      },
    ],
    output: { assets: [{ from: '$edit.assets[0]', label: 'edited' }] },
  } as PlanDag
}

function deps(
  overrides: Partial<Parameters<typeof preflightPlan>[1]> = {},
): Parameters<typeof preflightPlan>[1] {
  return {
    registry: makeRegistry(),
    router: explainingRouter(),
    ...overrides,
  }
}

function stepById(
  report: ReturnType<typeof preflightPlan>,
  id: string,
): ReturnType<typeof preflightPlan>['steps'][number] {
  const step = report.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no step ${id} in report`)
  return step
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('preflightPlan — a router that has explain', () => {
  it('reports the model and the selection rule for every satisfiable step', () => {
    const report = preflightPlan(CLIP_DAG, deps())

    const describeStep = stepById(report, 'describe')
    expect(describeStep.kind).toBe('atomic')
    expect(describeStep.routing).toMatchObject({
      kind: 'selected',
      model: 'openai:gpt-4.1',
      by: 'first-candidate',
    })
    // The full explanation rides along: this is the `--dump-config` surface for
    // "why that model", and a preflight that dropped it would send the host
    // back to the router to ask again.
    const routing = describeStep.routing
    if (routing.kind !== 'selected') throw new Error('unreachable')
    expect(routing.explanation?.capability).toBe('text-generation')
    expect(routing.explanation?.order).toEqual([
      'openai:gpt-4.1',
      'anthropic:claude-4',
    ])

    expect(stepById(report, 'render').routing).toMatchObject({
      kind: 'selected',
      model: 'fal:flux-pro',
      by: 'first-candidate',
    })
  })

  it('honours the host ResolveContext: a pin changes which model is reported', () => {
    const report = preflightPlan(
      CLIP_DAG,
      deps({
        resolveCtx: (spec: JobSpec): ResolveContext =>
          spec.patternId === 'text-generation'
            ? { pinnedModel: 'anthropic:claude-4' }
            : {},
      }),
    )

    expect(stepById(report, 'describe').routing).toMatchObject({
      kind: 'selected',
      model: 'anthropic:claude-4',
      by: 'pinned',
    })
  })

  it('reports a pin that is not a candidate as unsatisfiable, keeping the exact outcome on the explanation', () => {
    // The router's third outcome. `satisfiable` is true — candidates exist —
    // but `resolve` throws MODEL_EXCLUDED, so the step cannot run, which is
    // what preflight was asked. The report's two-way union has no member for
    // it; the explanation carries the truth.
    const report = preflightPlan(
      CLIP_DAG,
      deps({
        resolveCtx: (spec: JobSpec): ResolveContext =>
          spec.patternId === 'text-generation'
            ? { pinnedModel: 'openai:gpt-4.1', excludeModel: ['openai:gpt-4.1'] }
            : {},
      }),
    )

    const routing = stepById(report, 'describe').routing
    expect(routing.kind).toBe('unsatisfiable')
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.reason).toBe('all-excluded')
    expect(routing.explanation?.outcome).toMatchObject({
      kind: 'pin-excluded',
      pinnedModel: 'openai:gpt-4.1',
      excludedByRetry: true,
    })
  })
})

describe('preflightPlan — a two-method router', () => {
  it('degrades to checkSatisfiable and says so, rather than assuming the optional member', () => {
    const report = preflightPlan(
      CLIP_DAG,
      deps({ router: twoMethodRouter() }),
    )

    const routing = stepById(report, 'describe').routing
    expect(routing).toMatchObject({
      kind: 'selected',
      model: 'openai:gpt-4.1',
      // Not a RoutingSelectionRule: checkSatisfiable reports the candidate
      // LIST, so the model named is the first candidate rather than the one
      // resolve's precedence would land on.
      by: 'checkSatisfiable',
    })
    if (routing.kind !== 'selected') throw new Error('unreachable')
    expect(routing.explanation).toBeUndefined()

    expect(stepById(report, 'render').routing).toMatchObject({
      kind: 'selected',
      model: 'fal:flux-pro',
      by: 'checkSatisfiable',
    })
  })

  it('reports the unsatisfiable step and its alternative on the degraded path too', () => {
    const report = preflightPlan(
      CLIP_DAG,
      deps({ router: twoMethodRouter() }),
    )

    const routing = stepById(report, 'animate').routing
    expect(routing).toMatchObject({
      kind: 'unsatisfiable',
      reason: 'no-model-in-catalog',
    })
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.explanation).toBeUndefined()
    expect(routing.alternative).toMatchObject({
      id: 'via-frames',
      targetPatternId: 'meta_image-to-video-via-frames',
      losses: ['camera-motion'],
      wouldFire: false,
    })
  })
})

describe('preflightPlan — unsatisfiable steps and their alternatives', () => {
  it('names the first applicable declared path with its trade-off', () => {
    const report = preflightPlan(CLIP_DAG, deps())

    const routing = stepById(report, 'animate').routing
    expect(routing.kind).toBe('unsatisfiable')
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.reason).toBe('no-model-in-catalog')
    expect(routing.alternative).toEqual({
      id: 'via-frames',
      description: 'render the in-between frames and concatenate them',
      targetPatternId: 'meta_image-to-video-via-frames',
      preserves: ['subject-identity'],
      losses: ['camera-motion'],
      wouldFire: false,
    })
    expect(report.unsatisfiable).toEqual(['animate'])
  })

  it("wouldFire is the runtime's alternatives mode and nothing else", () => {
    const off = preflightPlan(CLIP_DAG, deps({ alternatives: 'off' }))
    const auto = preflightPlan(CLIP_DAG, deps({ alternatives: 'auto' }))
    const unset = preflightPlan(CLIP_DAG, deps())

    const fired = (report: ReturnType<typeof preflightPlan>) => {
      const routing = stepById(report, 'animate').routing
      if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
      return routing.alternative?.wouldFire
    }
    expect(fired(off)).toBe(false)
    expect(fired(auto)).toBe(true)
    // Absent is 'off', exactly as InlineRuntimeInit.alternatives defaults.
    expect(fired(unset)).toBe(false)
  })

  it('reaches the preserves-required evaluation through the step input', () => {
    // The one appliesWhen member keyed on the caller rather than the catalog.
    // It matches on overlap, so one of the two declared dimensions is enough.
    const report = preflightPlan(
      editDag(['subject-identity']),
      deps({ alternatives: 'auto' }),
    )

    const routing = stepById(report, 'edit').routing
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.alternative).toMatchObject({
      id: 'via-identity',
      targetPatternId: 'meta_identity-edit',
      preserves: ['subject-identity', 'composition'],
      losses: ['style'],
      wouldFire: true,
    })
  })

  it('does not advertise the path when the step requires nothing', () => {
    const report = preflightPlan(editDag(), deps())

    const routing = stepById(report, 'edit').routing
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.alternative).toBeUndefined()
    // 'style' is what the path loses, not what it preserves — no overlap.
    const noOverlap = preflightPlan(editDag(['style']), deps())
    const other = stepById(noOverlap, 'edit').routing
    if (other.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(other.alternative).toBeUndefined()
  })

  it('reads requiresSemantics defensively — a malformed value requires nothing', () => {
    // Convention, not schema: the field may arrive in shapes no schema
    // promised, and none of them may throw.
    for (const value of ['subject-identity', 42, null, { a: 1 }, [42, null]]) {
      const report = preflightPlan(editDag(value), deps())
      const routing = stepById(report, 'edit').routing
      if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
      expect(routing.alternative).toBeUndefined()
    }
    // …and non-string entries are dropped rather than poisoning the rest.
    const mixed = preflightPlan(editDag([42, 'subject-identity']), deps())
    const routing = stepById(mixed, 'edit').routing
    if (routing.kind !== 'unsatisfiable') throw new Error('unreachable')
    expect(routing.alternative).toMatchObject({ id: 'via-identity' })
  })
})

describe('preflightPlan — validation comes first', () => {
  it('returns the problems and nothing else', () => {
    const report = preflightPlan(
      {
        steps: [
          { id: 'a', pattern: 'no-such-pattern', input: { prompt: 'x' } },
          { id: 'b', pattern: 'text-generation', input: { prompt: '$c.text' } },
        ],
        output: { values: { a: '$a.text', b: '$b.text' } },
      } as PlanDag,
      deps(),
    )

    expect(report.ok).toBe(false)
    expect(report.steps).toEqual([])
    expect(report.levels).toEqual([])
    expect(report.unsatisfiable).toEqual([])
    expect(report.problems.map((p) => p.code)).toContain('PLAN_PATTERN_NOT_FOUND')
    expect(report.problems.map((p) => p.code)).toContain('PLAN_REF_UNKNOWN_STEP')
  })

  it('forwards audience, allow and selfId to the walk', () => {
    const allowed = preflightPlan(
      CLIP_DAG,
      deps({ allow: ['text-generation', 'text-to-image', 'image-to-video'] }),
    )
    expect(allowed.problems).toEqual([])

    const denied = preflightPlan(CLIP_DAG, deps({ allow: ['text-generation'] }))
    expect(denied.problems.map((p) => p.code)).toEqual([
      'PLAN_PATTERN_NOT_ALLOWED',
      'PLAN_PATTERN_NOT_ALLOWED',
    ])
    expect(denied.steps).toEqual([])

    const self = preflightPlan(CLIP_DAG, deps({ selfId: 'text-to-image' }))
    expect(self.problems.map((p) => p.code)).toContain('PLAN_PATTERN_SELF')
  })
})

describe('preflightPlan — levels', () => {
  it('groups steps into the stages the interpreter will run them in', () => {
    const report = preflightPlan(DIAMOND_DAG, deps())

    expect(report.problems).toEqual([])
    expect(report.levels).toEqual([['a', 'b'], ['c'], ['d']])
    expect(report.steps.map((s) => [s.id, s.level])).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', 2],
    ])
  })

  it('counts an asset reference as a dependency, not only a value one', () => {
    const report = preflightPlan(CLIP_DAG, deps())
    // `animate` reads `render` through `assets.startFrame` alone.
    expect(report.levels).toEqual([['describe'], ['render'], ['animate']])
  })
})

describe('preflightPlan — meta steps', () => {
  const metaDag = (id: string, input: Record<string, unknown>): PlanDag =>
    ({
      steps: [{ id: 'step', pattern: id, input }],
      output: { assets: [{ from: '$step.assets[label=clip]', label: 'out' }] },
    }) as PlanDag

  it('is opaque, and reports plannedDispatches when declared', () => {
    const report = preflightPlan(
      metaDag('meta_best-of-n', { innerPatternId: 'text-to-image', n: 3 }),
      deps(),
    )

    expect(report.problems).toEqual([])
    const step = stepById(report, 'step')
    expect(step.kind).toBe('meta')
    expect(step.routing).toEqual({
      kind: 'opaque',
      plannedDispatches: ['text-to-image'],
    })
  })

  it('reports undefined when a plannedDispatches declaration throws', () => {
    // Author code on a preflight path. "Not knowable" is the status quo for
    // every meta that does not declare, and it is what a broken declaration
    // has effectively told us — it must not propagate.
    const report = preflightPlan(
      metaDag('meta_broken-declaration', { prompt: 'x' }),
      deps(),
    )

    const routing = stepById(report, 'step').routing
    expect(routing).toEqual({ kind: 'opaque' })
    if (routing.kind !== 'opaque') throw new Error('unreachable')
    expect(routing.plannedDispatches).toBeUndefined()
    expect(report.ok).toBe(true)
  })

  it('expands a meta whose origin is plan one level, binding $input to its own inputs', () => {
    const report = preflightPlan(
      metaDag('meta_short-clip', { prompt: 'a red bicycle', motion: 'slow push-in' }),
      deps(),
    )

    const routing = stepById(report, 'step').routing
    if (routing.kind !== 'opaque') throw new Error('unreachable')
    const nested = routing.nested
    expect(nested).toBeDefined()
    if (!nested) throw new Error('unreachable')

    // `$input.prompt` / `$input.motion` resolve against the meta's own
    // tool.inputs — without that binding the walk would report
    // PLAN_REF_INPUT_NOT_ALLOWED and the expansion would be useless for
    // exactly the persisted plan it exists for.
    expect(nested.problems).toEqual([])
    expect(nested.steps.map((s) => s.id)).toEqual(['describe', 'render', 'animate'])
    expect(nested.levels).toEqual([['describe'], ['render'], ['animate']])
    expect(stepById(nested, 'describe').routing).toMatchObject({
      kind: 'selected',
      model: 'openai:gpt-4.1',
    })
    // `animate` is unsatisfiable inside the nested plan too — and its declared
    // alternative applies there exactly as it does at the top level.
    expect(nested.unsatisfiable).toEqual(['animate'])
    expect(nested.ok).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('does not forward audience into the nested walk — the outer gate already passed', () => {
    // A packaged plan whose inner step targets a host-only helper. The runtime
    // runs it: `runPlan` validates the inner DAG with no audience ("the
    // surface was checked at the boundary") and `ctx.step` has no exposure
    // gate. A preflight that forwarded `audience` would stamp
    // PLAN_PATTERN_NOT_EXPOSED on the inner step and render a runnable
    // packaged plan INVALID, with none of the per-step routing the report
    // exists to show.
    const registry = makeRegistry()
    registry.register({
      ...atomic({
        id: 'internal-caption',
        inputs: z.object({ prompt: z.string().max(4_000) }),
        outputs: TEXT_OUTPUT,
      }),
      exposure: 'no-tool',
    } as never)
    registry.register(
      planMeta('meta_host-only-clip', {
        steps: [
          {
            id: 'work',
            pattern: 'internal-caption',
            input: { prompt: '$input.prompt' },
          },
        ],
        output: { values: { line: '$work.text' } },
      } as PlanDag),
    )

    // Serve the helper too, so the only variable under test is the audience:
    // an unserved step would flip `nested.ok` for routing reasons of its own.
    const router = createDefaultCapabilityRouter({
      getModels: (cap) =>
        cap === 'internal-caption'
          ? [record('internal-caption', { provider: 'openai', modelId: 'gpt-4.1' })]
          : (CATALOG[cap] ?? []).map((m) => record(cap, m)),
    })
    const report = preflightPlan(
      metaDag('meta_host-only-clip', { prompt: 'a red bicycle' }),
      deps({ registry, router, audience: 'agent-loop' }),
    )

    // The OUTER walk still applies the audience — meta_host-only-clip is
    // 'agent-tool'-exposed, so the step is legal for this surface...
    expect(report.problems).toEqual([])
    const routing = stepById(report, 'step').routing
    if (routing.kind !== 'opaque') throw new Error('unreachable')
    const nested = routing.nested
    expect(nested).toBeDefined()
    if (!nested) throw new Error('unreachable')
    // ...and the INNER walk does not: no PLAN_PATTERN_NOT_EXPOSED on a step
    // the runtime would happily dispatch.
    expect(nested.problems).toEqual([])
    expect(nested.ok).toBe(true)
  })

  it("a nested plan's own verdict does not sink the plan that steps into it", () => {
    // Scoped on purpose. A meta is opaque and preflight never claimed one would
    // succeed; folding the nested verdict in would make a plan's `ok` depend on
    // how far the expansion happened to reach — a nested PLAN meta would gate
    // the parent while a hand-written meta doing the same work would not. The
    // host that cares reads both, and the formatter renders both.
    const report = preflightPlan(
      metaDag('meta_edit-clip', { prompt: 'a red bicycle' }),
      deps(),
    )

    const routing = stepById(report, 'step').routing
    if (routing.kind !== 'opaque') throw new Error('unreachable')
    expect(routing.nested?.unsatisfiable).toEqual(['edit'])
    expect(routing.nested?.ok).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('recurses exactly one level', () => {
    // The nested plan's own steps are atomic here; what this pins is that the
    // recursion is entered with depth 1 and stops — a nested report never
    // carries another nested report.
    const report = preflightPlan(
      metaDag('meta_short-clip', { prompt: 'a red bicycle', motion: 'slow push-in' }),
      deps(),
    )
    const routing = stepById(report, 'step').routing
    if (routing.kind !== 'opaque') throw new Error('unreachable')
    for (const step of routing.nested?.steps ?? []) {
      if (step.routing.kind === 'opaque') {
        expect(step.routing.nested).toBeUndefined()
      }
    }
  })
})

describe('preflightPlan — the synthesized spec', () => {
  it('hands resolveCtx a spec carrying the pattern id, the unsubstituted input and the sessionId', () => {
    const seen: JobSpec[] = []
    const resolveCtx = vi.fn((spec: JobSpec): ResolveContext => {
      seen.push(spec)
      return {}
    })

    preflightPlan(CLIP_DAG, deps({ resolveCtx, sessionId: 'session-7' }))

    // One call per ATOMIC step; a meta has no routing decision to make.
    expect(seen.map((s) => s.patternId)).toEqual([
      'text-generation',
      'text-to-image',
      'image-to-video',
    ])
    expect(seen.every((s) => s.sessionId === 'session-7')).toBe(true)
    // Refs unsubstituted: substitution needs outputs that do not exist yet, and
    // a host provider keys on pattern / session / providerOptions, not on
    // prompt text.
    expect(seen[1]?.input).toEqual({ prompt: '$describe.text' })
  })

  it('routes under {} when no provider is given', () => {
    const report = preflightPlan(CLIP_DAG, deps())
    const routing = stepById(report, 'describe').routing
    if (routing.kind !== 'selected') throw new Error('unreachable')
    expect(routing.explanation?.context).toEqual({})
  })

  it('omits sessionId from the spec when the host did not pass one', () => {
    const seen: JobSpec[] = []
    preflightPlan(
      CLIP_DAG,
      deps({
        resolveCtx: (spec: JobSpec): ResolveContext => {
          seen.push(spec)
          return {}
        },
      }),
    )
    expect(seen.every((s) => !('sessionId' in s))).toBe(true)
  })
})

describe('preflightPlan — ok', () => {
  it.each([
    {
      label: 'clean plan, every step served',
      dag: DIAMOND_DAG,
      alternatives: 'off' as const,
      ok: true,
      unsatisfiable: [] as string[],
    },
    {
      label: 'unsatisfiable step WITH an applicable alternative',
      dag: CLIP_DAG,
      alternatives: 'off' as const,
      ok: true,
      unsatisfiable: ['animate'],
    },
    {
      label: 'the same, under auto',
      dag: CLIP_DAG,
      alternatives: 'auto' as const,
      ok: true,
      unsatisfiable: ['animate'],
    },
    {
      label: 'unsatisfiable step with NO applicable alternative',
      dag: editDag(),
      alternatives: 'off' as const,
      ok: false,
      unsatisfiable: ['edit'],
    },
    {
      label: 'unsatisfiable step whose alternative applies once semantics are required',
      dag: editDag(['composition']),
      alternatives: 'off' as const,
      ok: true,
      unsatisfiable: ['edit'],
    },
  ])('$label → ok=$ok', ({ dag, alternatives, ok, unsatisfiable }) => {
    const report = preflightPlan(dag, deps({ alternatives }))
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(ok)
    expect(report.unsatisfiable).toEqual(unsatisfiable)
  })

  it('is false whenever there are problems, whatever the routing would have said', () => {
    const report = preflightPlan(
      {
        steps: [{ id: 'a', pattern: 'text-generation', input: { prompt: 'x' } }],
        output: {},
      } as PlanDag,
      deps(),
    )
    expect(report.problems.length).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
  })
})

describe('formatPlanPreflight', () => {
  it('renders one line per step in the shape the design pins', () => {
    const text = formatPlanPreflight(preflightPlan(CLIP_DAG, deps()))
    const lines = text.split('\n')

    expect(lines[0]).toBe('plan: 3 steps in 3 stages, 1 unsatisfiable')
    expect(text).toContain('describe  text-generation  → openai:gpt-4.1')
    expect(text).toContain('render    text-to-image    → fal:flux-pro')
    expect(text).toContain(
      'animate   image-to-video   ✗ no-model-in-catalog (would fall back to meta_image-to-video-via-frames under auto: loses camera-motion)',
    )
    expect(text).toContain('stages: 1 [describe]  2 [render]  3 [animate]')
    // No colour codes, ever — this goes into a confirm dialog and a log.
    expect(text).not.toContain(String.fromCharCode(27))
  })

  it("says 'falls back' rather than 'would fall back' under auto", () => {
    const text = formatPlanPreflight(
      preflightPlan(CLIP_DAG, deps({ alternatives: 'auto' })),
    )
    expect(text).toContain(
      '(falls back to meta_image-to-video-via-frames: loses camera-motion)',
    )
    expect(text).not.toContain('would fall back')
  })

  it('marks a report that is not ok, and renders a bare unsatisfiable step', () => {
    const text = formatPlanPreflight(preflightPlan(editDag(), deps()))
    expect(text).toContain('1 unsatisfiable — NOT ok')
    expect(text).toContain('✗ no-model-in-catalog')
    expect(text).not.toContain('fall back')
  })

  it('renders a meta as opaque, with its declared dispatches', () => {
    const text = formatPlanPreflight(
      preflightPlan(
        {
          steps: [
            {
              id: 'hero',
              pattern: 'meta_best-of-n',
              input: { innerPatternId: 'text-to-image', n: 3 },
            },
          ],
          output: { assets: [{ from: '$hero.assets[label=winner]', label: 'hero' }] },
        } as PlanDag,
        deps(),
      ),
    )
    expect(text).toContain('(meta, opaque; dispatches text-to-image)')
  })

  it('renders a nested plan indented under its step', () => {
    const text = formatPlanPreflight(
      preflightPlan(
        {
          steps: [
            {
              id: 'clip',
              pattern: 'meta_short-clip',
              input: { prompt: 'a red bicycle', motion: 'slow push-in' },
            },
          ],
          output: { assets: [{ from: '$clip.assets[label=clip]', label: 'out' }] },
        } as PlanDag,
        deps(),
      ),
    )
    expect(text).toContain('(meta, plan;')
    expect(text).toContain('  plan: 3 step(s) in 3 stage(s)')
    expect(text).toContain('    describe  text-generation  → openai:gpt-4.1')
    expect(text).toContain('✗ no-model-in-catalog')
  })

  it("carries a nested plan's own verdict into the rendered block", () => {
    const text = formatPlanPreflight(
      preflightPlan(
        {
          steps: [
            {
              id: 'clip',
              pattern: 'meta_edit-clip',
              input: { prompt: 'a red bicycle' },
            },
          ],
          output: { assets: [{ from: '$clip.assets[label=edited]', label: 'out' }] },
        } as PlanDag,
        deps(),
      ),
    )
    // The parent line says nothing is wrong at its own level; the nested block
    // is where the host reads that the inner plan cannot run.
    expect(text.split('\n')[0]).toBe('plan: 1 step in 1 stage')
    expect(text).toContain('  plan: 2 step(s) in 2 stage(s) — NOT ok')
  })

  it('renders the problem block instead of steps when the plan is invalid', () => {
    const text = formatPlanPreflight(
      preflightPlan(
        {
          steps: [{ id: 'a', pattern: 'no-such-pattern', input: {} }],
          output: { values: { a: '$a.text' } },
        } as PlanDag,
        deps(),
      ),
    )
    expect(text).toMatch(/^plan: INVALID — \d+ problems?, nothing routed$/m)
    expect(text).toContain('PLAN_PATTERN_NOT_FOUND at steps.0.pattern:')
    expect(text).not.toContain('stages:')
  })

  it('bounds the problem block', () => {
    // A schema-shaped mess produces one problem per zod issue; the formatter is
    // a dialog body, not a dump.
    const steps = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      pattern: 'nope',
      input: {},
    }))
    const text = formatPlanPreflight(
      preflightPlan({ steps, output: {} } as unknown as PlanDag, deps()),
    )
    expect(text.split('\n').length).toBeLessThanOrEqual(22)
    expect(text).toMatch(/… \+\d+ more$/)
  })
})

describe('preflightPlan — purity', () => {
  it('calls no model and never mutates the DAG it was handed', () => {
    const dag = structuredClone(CLIP_DAG)
    const before = JSON.stringify(dag)
    const registry = makeRegistry()

    const report = preflightPlan(dag, {
      registry,
      router: explainingRouter(),
      alternatives: 'auto',
      sessionId: 's1',
    })

    expect(JSON.stringify(dag)).toBe(before)
    expect(report.steps).toHaveLength(3)
    // The registry is untouched: nothing registered, nothing unregistered.
    expect(registry.get('meta_plan' as never)).toBeUndefined()
  })
})
