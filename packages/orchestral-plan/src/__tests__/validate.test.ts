import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  boundedText,
  defineAtomicPattern,
  dispatchEnvelopeShape,
  metaEnvelopeShape,
  PatternRegistry,
  producedAssetShape,
  resolveDispatchTarget,
  silentDiagnosticsLogger,
  type AgentPattern,
  type AssetNeed,
  type MetaPattern,
  type Pattern,
  type PatternId,
} from '@orchestral/core'

import {
  assertPlanValid,
  planRefine,
  PlanInvalidError,
  validatePlan,
  type PlanPatternLookup,
  type PlanProblem,
  type PlanProblemCode,
  type PlanValidateOptions,
} from '../validate'
import { PlanDagSchema, PlanOutputSchema, type PlanDag } from '../plan'

// ── Stub patterns ───────────────────────────────────────────────────────
//
// @orchestral/patterns depends on this package, never the other way round,
// so importing the REAL text-generation / text-to-image / image-to-video /
// image-to-text / meta_image-best-of-n here would be a package cycle. These
// stubs mirror only what the walk reads — the outputs shape (fields, the
// produced-assets element and its modality literal / label), `assetNeeds`, and
// enough of `tool.inputs` to exercise rule 21 — under the real ids, so the
// worked examples below are the doc's verbatim JSON. One deliberate addition
// is flagged where it appears: `imageToImageStub`'s `max` on an array slot,
// which no shipped atomic declares today but rule 18 has a clause for.

const textGenerationStub = defineAtomicPattern({
  id: 'text-generation',
  description: 'Generate text.',
  primary: {
    tool: {
      description: 'One-shot completion.',
      inputs: z.object({
        prompt: z.string().min(1, 'prompt required'),
        system: z.string().optional(),
        maxOutputTokens: z.number().int().min(1).max(128_000).default(2048),
        temperature: z.number().min(0).max(2).default(0.7),
        responseFormat: z.enum(['text', 'json']).default('text'),
      }),
    },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('text'),
    text: boundedText(65_536),
    ...dispatchEnvelopeShape,
    usage: z
      .object({
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .optional(),
  }),
})

const textToImageStub = defineAtomicPattern({
  id: 'text-to-image',
  description: 'Render an image from a prompt.',
  primary: {
    tool: {
      description: 'Render an image.',
      inputs: z.object({ prompt: z.string().min(1, 'prompt required') }),
    },
    modelTags: [],
  },
  assetNeeds: [
    { slot: 'reference', modality: 'image', cardinality: 'array', required: false },
    { slot: 'control', modality: 'image', cardinality: 'single', required: false },
  ] as const satisfies readonly AssetNeed[],
  outputs: z.object({
    modality: z.literal('image'),
    assets: z.array(z.object(producedAssetShape('image'))),
    ...dispatchEnvelopeShape,
  }),
})

const imageToVideoStub = defineAtomicPattern({
  id: 'image-to-video',
  description: 'Animate a still.',
  primary: {
    tool: {
      description: 'Animate a still.',
      inputs: z.object({ prompt: z.string().optional() }),
    },
    modelTags: [],
  },
  assetNeeds: [
    { slot: 'startFrame', modality: 'image', cardinality: 'single', required: true },
    { slot: 'endFrame', modality: 'image', cardinality: 'single', required: false },
    { slot: 'reference', modality: 'image', cardinality: 'array', required: false },
  ] as const satisfies readonly AssetNeed[],
  outputs: z.object({
    modality: z.literal('video'),
    assets: z.array(z.object(producedAssetShape('video'))),
    ...dispatchEnvelopeShape,
  }),
})

const imageToTextStub = defineAtomicPattern({
  id: 'image-to-text',
  description: 'Read an image.',
  primary: {
    tool: {
      description: 'Read an image.',
      inputs: z.object({
        prompt: z.string().optional(),
        system: z.string().optional(),
        mode: z.enum(['caption', 'describe', 'judge', 'extract-style']).default('caption'),
        responseFormat: z.enum(['text', 'json']).default('text'),
      }),
    },
    modelTags: [],
  },
  assetNeeds: [
    { slot: 'source', modality: 'image', cardinality: 'array', required: true },
  ] as const satisfies readonly AssetNeed[],
  outputs: z.object({
    modality: z.literal('text'),
    text: boundedText(16_384),
    ...dispatchEnvelopeShape,
  }),
})

/**
 * The one stub that is NOT a mirror: `reference` carries `max: 2`. No shipped
 * atomic declares an upper bound on an array slot today, and rule 18's
 * over-max clause needs one to have anything to bite on.
 */
const imageToImageStub = defineAtomicPattern({
  id: 'image-to-image',
  description: 'Edit an image.',
  primary: {
    tool: {
      description: 'Edit an image.',
      inputs: z.object({ prompt: z.string().min(1) }),
    },
    modelTags: [],
  },
  assetNeeds: [
    { slot: 'source', modality: 'image', cardinality: 'single', required: true },
    { slot: 'reference', modality: 'image', cardinality: 'array', required: false, max: 2 },
  ] as const satisfies readonly AssetNeed[],
  outputs: z.object({
    modality: z.literal('image'),
    assets: z.array(z.object(producedAssetShape('image'))),
    ...dispatchEnvelopeShape,
  }),
})

/** meta_image-best-of-n: labelled assets, so `[label=winner]` is legal on it. */
const bestOfNStub: MetaPattern = {
  id: 'meta_image-best-of-n',
  kind: 'meta',
  description: 'Render N candidates and pick one.',
  tool: {
    description: 'Best of N.',
    inputs: z.object({
      innerPatternId: z.enum(['text-to-image', 'image-to-image']),
      innerInput: z.unknown(),
      n: z.number().int().min(2).max(8),
      targetDescription: z.string().min(1),
    }),
  },
  outputs: z.object({
    assets: z.array(
      z.object({ ...producedAssetShape('image'), label: boundedText(64) }),
    ),
    reason: boundedText(2_048),
    cost: metaEnvelopeShape.cost,
    latencyMs: metaEnvelopeShape.latencyMs.int().min(0),
  }),
  compose: async () => {
    throw new Error('stub compose is never executed')
  },
}

/** The plan meta itself, so rule 12 has something registered to refuse. */
const planMetaStub: MetaPattern = {
  id: 'meta_plan',
  kind: 'meta',
  description: 'Execute an LLM-authored pipeline.',
  tool: { description: 'Run a plan.', inputs: PlanDagSchema },
  outputs: PlanOutputSchema,
  compose: async () => {
    throw new Error('stub compose is never executed')
  },
}

const agentStub: AgentPattern = {
  id: 'agent_director',
  kind: 'agent',
  description: 'A sub-agent.',
  primary: {
    tool: { description: 'Direct.', inputs: z.object({ brief: z.string() }) },
    modelTags: [],
  },
  outputs: z.object({ summary: boundedText(1_024) }),
  loop: { toolPatternIds: [] as PatternId[] },
} as unknown as AgentPattern

/** Host-only: rule 13 needs a pattern no LLM surface can see. */
const hostOnlyStub = defineAtomicPattern({
  id: 'text-to-speech',
  description: 'Speak.',
  exposure: 'no-tool',
  primary: {
    tool: { description: 'Speak.', inputs: z.object({ text: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('audio'),
    assets: z.array(z.object(producedAssetShape('audio'))),
    ...dispatchEnvelopeShape,
  }),
})

/** Subagent-only, for the `chat-turn` half of rule 13. */
const agentToolStub = defineAtomicPattern({
  id: 'text-to-speech',
  description: 'Speak, for sub-agents only.',
  exposure: 'agent-tool',
  primary: {
    tool: { description: 'Speak.', inputs: z.object({ text: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    modality: z.literal('audio'),
    assets: z.array(z.object(producedAssetShape('audio'))),
    ...dispatchEnvelopeShape,
  }),
})

/**
 * Two patterns the walk deliberately CANNOT introspect. They exist to pin the
 * fail-open contract: an outputs schema the walk cannot read must accept, never
 * accuse — a false refusal blocks a legal plan, which is worse than a typo
 * layer 2 catches at the step.
 */
const enumModalityStub = defineAtomicPattern({
  id: 'image-to-image',
  description: 'A producer whose asset modality is an enum, not a literal.',
  primary: {
    tool: { description: 'Edit.', inputs: z.object({ prompt: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.object({
    assets: z.array(
      z.object({
        assetId: z.string().max(128),
        modality: z.enum(['image', 'video']),
      }),
    ),
    ...dispatchEnvelopeShape,
  }),
})

const opaqueOutputsStub = defineAtomicPattern({
  id: 'text-to-speech',
  description: 'A producer whose outputs are not a ZodObject at all.',
  primary: {
    tool: { description: 'Speak.', inputs: z.object({ text: z.string().min(1) }) },
    modelTags: [],
  },
  outputs: z.record(z.string(), z.unknown()),
})

const ALL_STUBS: readonly Pattern[] = [
  textGenerationStub as unknown as Pattern,
  textToImageStub as unknown as Pattern,
  imageToVideoStub as unknown as Pattern,
  imageToTextStub as unknown as Pattern,
  imageToImageStub as unknown as Pattern,
  hostOnlyStub as unknown as Pattern,
  bestOfNStub as unknown as Pattern,
  planMetaStub as unknown as Pattern,
  agentStub as unknown as Pattern,
]

function makeLookup(patterns: readonly Pattern[] = ALL_STUBS): PlanPatternLookup {
  const byId = new Map<string, Pattern>(patterns.map((p) => [p.id, p]))
  return {
    get: (id) => byId.get(id),
    getEntry: (id) => {
      const pattern = byId.get(id)
      return pattern === undefined ? undefined : { pattern, alternatives: [] }
    },
  }
}

const lookup = makeLookup()

// ── Fixtures ────────────────────────────────────────────────────────────

/** The red bicycle, in the one-shot form: no `$input`, literal prompts. */
function bicycle(): PlanDag {
  return {
    description: 'Describe, render and animate one short clip.',
    steps: [
      {
        id: 'describe',
        pattern: 'text-generation',
        input: {
          system: 'You are a cinematographer. Turn the subject into one line.',
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
}

/** Worked example 1, verbatim from docs/plan.md — the persisted `$input` form. */
const WORKED_EXAMPLE_1: PlanDag = {
  description: 'Describe, render and animate one short clip.',
  steps: [
    {
      id: 'describe',
      pattern: 'text-generation',
      input: {
        system:
          'You are a cinematographer. Turn the subject into one line describing a single still shot: framing, light, lens. No preamble.',
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

/** Worked example 2, verbatim from docs/plan.md. */
const WORKED_EXAMPLE_2: PlanDag = {
  steps: [
    { id: 'take-0', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    { id: 'take-1', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    { id: 'take-2', pattern: 'text-to-image', input: { prompt: '$input.prompt' } },
    {
      id: 'judge',
      pattern: 'image-to-text',
      input: {
        prompt:
          'Images 0-2 are candidates for one prompt. Reply with the index of the strongest and one sentence why.',
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

const PLAN_INPUTS = z.object({
  prompt: z.string().min(1).max(2_000),
  motion: z.string().min(1).max(500),
})

function codesOf(problems: readonly PlanProblem[]): PlanProblemCode[] {
  return problems.map((p) => p.code)
}

/**
 * Assert that `mutate` turns a clean plan into one whose ONLY problem is
 * `code`, and hand the problem back for its details. The clean half is the
 * point: a rule that fires on the untouched fixture would pass a "does it
 * report X" assertion while blocking every legal plan.
 */
function flip(
  code: PlanProblemCode,
  mutate: (dag: PlanDag) => void,
  opts: PlanValidateOptions = {},
  base: () => PlanDag = bicycle,
): PlanProblem {
  expect(validatePlan(base(), lookup, opts)).toEqual([])
  const dag = base()
  mutate(dag)
  const problems = validatePlan(dag, lookup, opts)
  expect(codesOf(problems)).toEqual([code])
  return problems[0]
}

describe('validatePlan — the worked examples', () => {
  it('example 1 (red bicycle) validates clean', () => {
    expect(
      validatePlan(WORKED_EXAMPLE_1, lookup, { inputs: PLAN_INPUTS }),
    ).toEqual([])
  })

  it('example 2 (three takes, a judge, a winner) validates clean', () => {
    expect(
      validatePlan(WORKED_EXAMPLE_2, lookup, { inputs: PLAN_INPUTS }),
    ).toEqual([])
  })

  it('the one-shot bicycle validates clean with no plan parameters', () => {
    expect(validatePlan(bicycle(), lookup, {})).toEqual([])
  })

  it('identical fan-out steps are legal — a plan keys its steps by id', () => {
    const problems = validatePlan(WORKED_EXAMPLE_2, lookup, { inputs: PLAN_INPUTS })
    expect(problems).toEqual([])
    // take-0..2 have byte-identical pattern + input.
    expect(WORKED_EXAMPLE_2.steps[0].input).toEqual(WORKED_EXAMPLE_2.steps[1].input)
  })
})

describe('validatePlan — rule 1, PLAN_SCHEMA', () => {
  it('reports one problem per zod issue', () => {
    const dag = bicycle()
    ;(dag.steps[0] as { id: string }).id = 'bad/id'
    const problems = validatePlan(dag, lookup, {})
    const schema = problems.filter((p) => p.code === 'PLAN_SCHEMA')
    expect(schema).toHaveLength(1)
    expect(schema[0].path).toEqual(['steps', 0, 'id'])
    expect(schema[0].details?.issue).toBeDefined()
  })

  it('an empty step list is a schema problem', () => {
    const problems = validatePlan({ steps: [], output: {} } as unknown as PlanDag, lookup, {})
    expect(codesOf(problems)).toContain('PLAN_SCHEMA')
  })

  it('graph rules still run against a dag the schema rejected', () => {
    // A step id with a '/' fails the regex AND is referenced nowhere: the walk
    // must not stop at the shape error.
    const dag = bicycle()
    ;(dag.steps[0] as { id: string }).id = 'bad/id'
    const codes = codesOf(validatePlan(dag, lookup, {}))
    expect(codes).toContain('PLAN_SCHEMA')
    expect(codes).toContain('PLAN_REF_UNKNOWN_STEP') // $describe.text now dangles
  })
})

describe('validatePlan — rules 2 and 3, step ids', () => {
  it('PLAN_STEP_ID_DUPLICATE', () => {
    const problem = flip('PLAN_STEP_ID_DUPLICATE', (dag) => {
      dag.steps.push({ id: 'describe', pattern: 'text-generation', input: { prompt: 'x' } })
    })
    expect(problem.details).toMatchObject({ stepId: 'describe' })
    expect(problem.path).toEqual(['steps', 3, 'id'])
  })

  it('PLAN_STEP_ID_RESERVED — a step may not be called `input`', () => {
    const dag = bicycle()
    dag.steps[0].id = 'input'
    const codes = codesOf(validatePlan(dag, lookup, {}))
    expect(codes).toContain('PLAN_STEP_ID_RESERVED')
  })
})

describe('validatePlan — rule 4, PLAN_REF_SYNTAX', () => {
  it('flags a whole string that starts like a ref and is neither production', () => {
    const problem = flip('PLAN_REF_SYNTAX', (dag) => {
      dag.steps[1].input.prompt = '$describe'
    })
    expect(problem.details).toMatchObject({ value: '$describe' })
  })

  it('"$5.99" stays literal — a digit after the $ is not a reference', () => {
    const dag = bicycle()
    dag.steps[1].input.prompt = 'a bicycle priced at $5.99, shot on 35mm'
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })

  it('prose mentioning an unknown $word stays literal', () => {
    const dag = bicycle()
    dag.steps[1].input.prompt = 'the $subject.field notation is not used here'
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })
})

describe('validatePlan — rule 5, reference targets', () => {
  it('PLAN_REF_UNKNOWN_STEP', () => {
    const problem = flip('PLAN_REF_UNKNOWN_STEP', (dag) => {
      dag.steps[1].input.prompt = '$nosuch.text'
    })
    expect(problem.details).toMatchObject({ ref: '$nosuch.text', target: 'nosuch' })
  })

  it('PLAN_REF_FORWARD — a reference may only point at an earlier step', () => {
    const problem = flip('PLAN_REF_FORWARD', (dag) => {
      dag.steps[1].input.prompt = '$animate.modality'
    })
    expect(problem.details).toMatchObject({ stepId: 'render', target: 'animate' })
  })

  it('a self-reference is a forward reference', () => {
    const dag = bicycle()
    dag.steps[1].input.prompt = '$render.modality'
    expect(codesOf(validatePlan(dag, lookup, {}))).toContain('PLAN_REF_FORWARD')
  })
})

describe('validatePlan — rule 6, PLAN_REF_PATH_UNKNOWN', () => {
  it('reports the producer top-level output keys as `available`', () => {
    const problem = flip('PLAN_REF_PATH_UNKNOWN', (dag) => {
      dag.steps[1].input.prompt = '$describe.output'
    })
    expect(problem.details?.available).toEqual([
      'modality',
      'text',
      'cost',
      'latencyMs',
      'model',
      'provider',
      'usage',
    ])
    expect(problem.message).toContain('text')
  })

  it('walks through ZodOptional and ZodObject', () => {
    const ok = bicycle()
    ok.steps[1].input.prompt = '$describe.usage.outputTokens'
    expect(validatePlan(ok, lookup, {})).toEqual([])

    const bad = bicycle()
    bad.steps[1].input.prompt = '$describe.usage.nope'
    expect(codesOf(validatePlan(bad, lookup, {}))).toEqual(['PLAN_REF_PATH_UNKNOWN'])
  })

  it('an index step into a non-array accepts rather than guessing', () => {
    const dag = bicycle()
    dag.steps[1].input.prompt = '$describe.text[0]'
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })
})

describe('validatePlan — rule 7, PLAN_REF_INTO_ASSETS', () => {
  it('flags an asset reference inside `input`', () => {
    const problem = flip('PLAN_REF_INTO_ASSETS', (dag) => {
      dag.steps[2].input.image = '$render.assets[0]'
    })
    expect(problem.details).toMatchObject({ ref: '$render.assets[0]' })
  })

  it('flags the mistake the derived references copy steers toward', () => {
    const dag = bicycle()
    dag.steps[2].input.references = { startFrame: '$render.assets[0]' }
    const codes = codesOf(validatePlan(dag, lookup, {}))
    expect(codes).toContain('PLAN_REF_INTO_ASSETS')
  })

  it('flags the label form too', () => {
    const dag = bicycle()
    dag.steps[2].input.hero = '$render.assets[label=winner]'
    expect(codesOf(validatePlan(dag, lookup, {}))).toEqual(['PLAN_REF_INTO_ASSETS'])
  })

  it('flags an asset ref returned as an `output.values` entry', () => {
    // `values` is declared as text. The one spelling that survives the output
    // schema — `$render.assets[0].assetId` — is worse than the one that does
    // not: it hands the model a raw asset id, which is exactly what the
    // projection's assets-only rewrite exists to prevent.
    for (const ref of ['$render.assets[0]', '$render.assets[0].assetId']) {
      const dag = bicycle()
      ;(dag.output.values as Record<string, string>).still = ref
      const problems = validatePlan(dag, lookup, {})
      expect(codesOf(problems), ref).toEqual(['PLAN_REF_INTO_ASSETS'])
      expect(problems[0].path).toEqual(['output', 'values', 'still'])
    }
  })

  it('does NOT flag a plan parameter that happens to be called `assets`', () => {
    const dag = bicycle()
    dag.steps[0].input.prompt = '$input.assets'
    expect(
      validatePlan(dag, lookup, { inputs: z.object({ assets: z.string() }) }),
    ).toEqual([])
  })
})

describe('validatePlan — rule 8, $input', () => {
  it('PLAN_REF_INPUT_NOT_ALLOWED when the plan takes no parameters', () => {
    const problem = flip('PLAN_REF_INPUT_NOT_ALLOWED', (dag) => {
      dag.steps[0].input.prompt = '$input.prompt'
    })
    expect(problem.details).toMatchObject({ ref: '$input.prompt', available: [] })
  })

  it('PLAN_PARAM_UNKNOWN when the field is not on the plan inputs schema', () => {
    const problem = flip(
      'PLAN_PARAM_UNKNOWN',
      (dag) => {
        dag.steps[0].input.prompt = '$input.subject'
      },
      { inputs: PLAN_INPUTS },
    )
    expect(problem.details?.available).toEqual(['prompt', 'motion'])
  })

  it('`$inputs.x` is a step reference, not a parameter reference', () => {
    const dag = bicycle()
    dag.steps[0].input.prompt = '$inputs.prompt'
    const problems = validatePlan(dag, lookup, { inputs: PLAN_INPUTS })
    expect(codesOf(problems)).toEqual(['PLAN_REF_UNKNOWN_STEP'])
    expect(problems[0].details).toMatchObject({ target: 'inputs' })
  })
})

describe('validatePlan — rule 9, PLAN_REF_IN_LITERAL', () => {
  it('flags a reference buried in a longer string', () => {
    const problem = flip('PLAN_REF_IN_LITERAL', (dag) => {
      dag.steps[2].input.prompt = 'Animate: $describe.text'
    })
    expect(problem.details).toMatchObject({ fragment: '$describe.text' })
  })

  it('flags `$input.` fragments too', () => {
    const dag = bicycle()
    dag.steps[2].input.prompt = 'motion is $input.motion'
    expect(codesOf(validatePlan(dag, lookup, { inputs: PLAN_INPUTS }))).toEqual([
      'PLAN_REF_IN_LITERAL',
    ])
  })

  it('takes precedence over rule 4 for the same string', () => {
    const dag = bicycle()
    dag.steps[2].input.prompt = '$describe.text and then some'
    expect(codesOf(validatePlan(dag, lookup, {}))).toEqual(['PLAN_REF_IN_LITERAL'])
  })
})

describe('validatePlan — rules 10 to 14, the target pattern', () => {
  it('PLAN_PATTERN_NOT_FOUND', () => {
    const problem = flip('PLAN_PATTERN_NOT_FOUND', (dag) => {
      dag.steps[1].pattern = 'text-to-hologram'
    })
    expect(problem.details).toMatchObject({ pattern: 'text-to-hologram' })
  })

  it('PLAN_PATTERN_KIND_AGENT — by kind, not by prefix', () => {
    const dag = bicycle()
    dag.steps[0].pattern = 'agent_director'
    dag.steps[0].input = { brief: 'go' }
    const codes = codesOf(validatePlan(dag, lookup, {}))
    expect(codes).toContain('PLAN_PATTERN_KIND_AGENT')
  })

  it('PLAN_PATTERN_SELF', () => {
    const dag = bicycle()
    dag.steps[0].pattern = 'meta_plan'
    const codes = codesOf(validatePlan(dag, lookup, { selfId: 'meta_plan' }))
    expect(codes).toContain('PLAN_PATTERN_SELF')
  })

  it('PLAN_PATTERN_NOT_EXPOSED — only when an audience is given', () => {
    const dag = bicycle()
    dag.steps.push({
      id: 'speak',
      pattern: 'text-to-speech',
      input: { text: '$describe.text' },
    })
    dag.output.assets?.push({ from: '$speak.assets[0]', label: 'vo' })
    // No audience: host-direct submit has no exposure gate.
    expect(validatePlan(dag, lookup, {})).toEqual([])
    const problems = validatePlan(dag, lookup, { audience: 'agent-loop' })
    expect(codesOf(problems)).toEqual(['PLAN_PATTERN_NOT_EXPOSED'])
    expect(problems[0].details).toMatchObject({
      pattern: 'text-to-speech',
      audience: 'agent-loop',
    })
  })

})

describe('validatePlan — rule 13 per audience', () => {
  /** `text-to-speech` fed by `describe`, returned so rule 22 stays quiet. */
  function withSpeech(): PlanDag {
    const dag = bicycle()
    dag.steps.push({
      id: 'speak',
      pattern: 'text-to-speech',
      input: { text: '$describe.text' },
    })
    dag.output.assets?.push({ from: '$speak.assets[0]', label: 'vo' })
    return dag
  }

  it('a no-tool pattern is refused on both LLM surfaces', () => {
    for (const audience of ['chat-turn', 'agent-loop'] as const) {
      expect(codesOf(validatePlan(withSpeech(), lookup, { audience })), audience).toEqual([
        'PLAN_PATTERN_NOT_EXPOSED',
      ])
    }
  })

  it('an agent-tool pattern is refused on chat-turn and allowed in an agent loop', () => {
    const agentToolLookup = makeLookup([...ALL_STUBS, agentToolStub as unknown as Pattern])
    expect(
      codesOf(validatePlan(withSpeech(), agentToolLookup, { audience: 'chat-turn' })),
    ).toEqual(['PLAN_PATTERN_NOT_EXPOSED'])
    expect(
      validatePlan(withSpeech(), agentToolLookup, { audience: 'agent-loop' }),
    ).toEqual([])
  })
})

describe('validatePlan — the walk fails open when it cannot introspect', () => {
  it('a producer whose modality is an enum, not a literal, is not accused', () => {
    const enumLookup = makeLookup([...ALL_STUBS, enumModalityStub as unknown as Pattern])
    const dag: PlanDag = {
      steps: [
        { id: 'edit', pattern: 'image-to-image', input: { prompt: 'edit it' } },
        {
          id: 'animate',
          pattern: 'image-to-video',
          input: {},
          assets: { startFrame: '$edit.assets[0]' },
        },
      ],
      output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
    }
    expect(validatePlan(dag, enumLookup, {})).toEqual([])
  })

  it('a producer whose outputs are not a ZodObject is not accused of producing nothing', () => {
    const opaqueLookup = makeLookup([...ALL_STUBS, opaqueOutputsStub as unknown as Pattern])
    const dag: PlanDag = {
      steps: [
        { id: 'speak', pattern: 'text-to-speech', input: { text: 'hello' } },
        {
          id: 'animate',
          pattern: 'image-to-video',
          input: {},
          assets: { startFrame: '$speak.assets[0]' },
        },
      ],
      output: { assets: [{ from: '$animate.assets[0]', label: 'clip' }] },
    }
    // Neither PLAN_ASSET_PRODUCER_NONE nor PLAN_SLOT_MODALITY: nothing is
    // knowable here, and a false refusal would block a legal plan.
    expect(validatePlan(dag, opaqueLookup, {})).toEqual([])
    // The same shape against a producer we CAN read does get refused.
    const readable = { ...dag, steps: [...dag.steps] }
    readable.steps[0] = { id: 'speak', pattern: 'text-generation', input: { prompt: 'hello' } }
    expect(codesOf(validatePlan(readable, lookup, {}))).toEqual([
      'PLAN_ASSET_PRODUCER_NONE',
    ])
  })
})

describe('validatePlan — a step whose target is itself a plan', () => {
  /**
   * `origin: 'plan'` without a `.plan` step list on the pattern is the
   * ONE-SHOT interpreter, whose whole `input` IS another DAG. Naming it as a
   * step is refused outright (PLAN_PATTERN_ONE_SHOT): the outer substitution
   * would rewrite the inner DAG's `$refs` before it ran. The refusal must be
   * the ONLY problem — the inner refs name the INNER plan's steps, so the
   * outer walk reading them as its own would bury the refusal that carries
   * the remedy under false grammar complaints.
   *
   * A PERSISTED plan carries its frozen list as `.plan` and is an ordinary
   * steppable meta: its input is parameters of THIS plan's namespace, walked
   * like any other step's.
   */
  const nestedPlanStub: MetaPattern = {
    id: 'meta_nested-plan',
    kind: 'meta',
    origin: 'plan',
    description: 'The one-shot, called as a step of another plan.',
    tool: { description: 'Run a nested plan.', inputs: PlanDagSchema },
    outputs: PlanOutputSchema,
    compose: async () => {
      throw new Error('stub compose is never executed')
    },
  }
  const nestedLookup = makeLookup([...ALL_STUBS, nestedPlanStub as unknown as Pattern])

  /** An inner DAG whose refs would every one of them be wrong out here. */
  const innerDag = {
    steps: [
      { id: 'take', pattern: 'text-to-image', input: { prompt: '$input.subject' } },
      {
        id: 'clip',
        pattern: 'image-to-video',
        input: { prompt: 'slow pan' },
        assets: { startFrame: '$take.assets[0]' },
      },
    ],
    output: { assets: [{ from: '$clip.assets[0]', label: 'clip' }] },
  }

  it('nesting the one-shot is refused, and the refusal is the only problem', () => {
    const dag: PlanDag = {
      steps: [{ id: 'inner', pattern: 'meta_nested-plan', input: innerDag }],
      output: { assets: [{ from: '$inner.assets[label=clip]', label: 'clip' }] },
    }
    // Exactly one problem. Without the one-shot skip the outer walk would pile
    // on, at minimum: PLAN_REF_INPUT_NOT_ALLOWED for `$input.subject` (this
    // plan takes no parameters), PLAN_REF_UNKNOWN_STEP for `$take.assets[0]`
    // (no step named `take` out here), and PLAN_REF_INTO_ASSETS on top of it.
    const problems = validatePlan(dag, nestedLookup, {})
    expect(codesOf(problems)).toEqual(['PLAN_PATTERN_ONE_SHOT'])
    expect(problems[0]!.message).toContain('planToMeta')
  })

  it('a ref into the nested plan still counts as reading the step it names', () => {
    // The outer `describe` step is read ONLY from inside the nested DAG. Rule
    // 22 must still see that read — the step is refused, but a refusal must
    // stay orthogonal: piling a false PLAN_STEP_UNUSED on `describe` would
    // send the author fixing a step that is not the problem.
    const dag: PlanDag = {
      steps: [
        {
          id: 'describe',
          pattern: 'text-generation',
          input: { prompt: 'a red bicycle' },
        },
        {
          id: 'inner',
          pattern: 'meta_nested-plan',
          input: {
            ...innerDag,
            steps: [
              { id: 'take', pattern: 'text-to-image', input: { prompt: '$describe.text' } },
              innerDag.steps[1],
            ],
          },
        },
      ],
      output: { assets: [{ from: '$inner.assets[label=clip]', label: 'clip' }] },
    }
    expect(codesOf(validatePlan(dag, nestedLookup, {}))).toEqual(['PLAN_PATTERN_ONE_SHOT'])
  })

  it('an ordinary meta step is still walked — skip and refusal key on the one-shot alone', () => {
    const dag: PlanDag = {
      steps: [
        {
          id: 'hero',
          pattern: 'meta_image-best-of-n',
          input: {
            innerPatternId: 'text-to-image',
            innerInput: { prompt: '$nowhere.text' },
            n: 3,
            targetDescription: 'a red bicycle',
          },
        },
      ],
      output: { assets: [{ from: '$hero.assets[label=winner]', label: 'hero' }] },
    }
    expect(codesOf(validatePlan(dag, nestedLookup, {}))).toEqual([
      'PLAN_REF_UNKNOWN_STEP',
    ])
  })

  it('a PERSISTED plan (`.plan` on the pattern) is steppable, its params walked normally', () => {
    const persistedPlanStub = {
      ...nestedPlanStub,
      id: 'meta_persisted-plan',
      description: 'A planToMeta product: frozen steps, parameter input.',
      tool: { description: 'Reusable pipeline.', inputs: z.object({ subject: z.string() }) },
      plan: innerDag,
    }
    const persistedLookup = makeLookup([...ALL_STUBS, persistedPlanStub as unknown as Pattern])
    const dag: PlanDag = {
      steps: [
        { id: 'describe', pattern: 'text-generation', input: { prompt: 'a red bicycle' } },
        { id: 'reuse', pattern: 'meta_persisted-plan', input: { subject: '$describe.text' } },
      ],
      output: { assets: [{ from: '$reuse.assets[label=clip]', label: 'clip' }] },
    }
    expect(validatePlan(dag, persistedLookup, {})).toEqual([])
    // ...and the walk is the NORMAL one — a typo'd ref filling its parameters
    // is caught here, not left for the runtime substitution to trip over.
    const typod: PlanDag = {
      steps: [
        { id: 'reuse', pattern: 'meta_persisted-plan', input: { subject: '$nowhere.text' } },
      ],
      output: { assets: [{ from: '$reuse.assets[label=clip]', label: 'clip' }] },
    }
    expect(codesOf(validatePlan(typod, persistedLookup, {}))).toEqual(['PLAN_REF_UNKNOWN_STEP'])
  })
})

describe('validatePlan — rule 14, PLAN_PATTERN_NOT_ALLOWED', () => {
  it('refuses a pattern outside the allowlist an agent loop inherits', () => {
    const problems = validatePlan(bicycle(), lookup, {
      allow: ['text-generation', 'text-to-image'] as PatternId[],
    })
    expect(codesOf(problems)).toEqual(['PLAN_PATTERN_NOT_ALLOWED'])
    expect(problems[0].details).toMatchObject({
      pattern: 'image-to-video',
      allowlist: ['text-generation', 'text-to-image'],
    })
  })

  it('passes when every step is on the list', () => {
    expect(
      validatePlan(bicycle(), lookup, {
        allow: ['text-generation', 'text-to-image', 'image-to-video'] as PatternId[],
      }),
    ).toEqual([])
  })
})

describe('validatePlan — rule 15, what a producer can supply', () => {
  it('PLAN_ASSET_PRODUCER_NONE', () => {
    const problem = flip('PLAN_ASSET_PRODUCER_NONE', (dag) => {
      dag.steps[2].assets = { startFrame: '$describe.assets[0]' }
      // Keep `render` read by something, so rule 22 stays out of the way.
      dag.output.assets?.push({ from: '$render.assets[0]', label: 'still' })
    })
    expect(problem.details).toMatchObject({ target: 'describe' })
  })

  it('PLAN_ASSET_LABEL_UNSUPPORTED — atomics do not label their assets', () => {
    const problem = flip('PLAN_ASSET_LABEL_UNSUPPORTED', (dag) => {
      dag.steps[2].assets = { startFrame: '$render.assets[label=winner]' }
    })
    expect(problem.details).toMatchObject({ target: 'render' })
    expect(problem.message).toContain('assets[0]')
  })

  it('a meta_* producer does label them', () => {
    expect(
      validatePlan(WORKED_EXAMPLE_2, lookup, { inputs: PLAN_INPUTS }),
    ).toEqual([])
  })
})

describe('validatePlan — rules 16 to 20, slots', () => {
  it('PLAN_SLOT_UNKNOWN', () => {
    const problem = flip('PLAN_SLOT_UNKNOWN', (dag) => {
      ;(dag.steps[2].assets as Record<string, string>).firstFrame = '$render.assets[0]'
    })
    expect(problem.details).toMatchObject({
      slot: 'firstFrame',
      declared: ['startFrame', 'endFrame', 'reference'],
    })
  })

  it('PLAN_SLOT_MODALITY', () => {
    const dag = bicycle()
    dag.steps.push({
      id: 'again',
      pattern: 'image-to-video',
      input: {},
      assets: { startFrame: '$animate.assets[0]' },
    })
    dag.output.assets?.push({ from: '$again.assets[0]', label: 'clip2' })
    const problems = validatePlan(dag, lookup, {})
    expect(codesOf(problems)).toEqual(['PLAN_SLOT_MODALITY'])
    expect(problems[0].details).toMatchObject({
      slot: 'startFrame',
      expected: 'image',
      got: 'video',
    })
  })

  it('PLAN_SLOT_CARDINALITY — a list on a single slot', () => {
    const problem = flip('PLAN_SLOT_CARDINALITY', (dag) => {
      dag.steps[2].assets = { startFrame: ['$render.assets[0]'] }
    })
    expect(problem.details).toMatchObject({ cardinality: 'single', count: 1 })
  })

  it('PLAN_SLOT_CARDINALITY — more refs than an array slot accepts', () => {
    const dag: PlanDag = {
      steps: [
        { id: 'a', pattern: 'text-to-image', input: { prompt: 'one' } },
        { id: 'b', pattern: 'text-to-image', input: { prompt: 'two' } },
        { id: 'c', pattern: 'text-to-image', input: { prompt: 'three' } },
        {
          id: 'edit',
          pattern: 'image-to-image',
          input: { prompt: 'blend' },
          assets: {
            source: '$a.assets[0]',
            reference: ['$a.assets[0]', '$b.assets[0]', '$c.assets[0]'],
          },
        },
      ],
      output: { assets: [{ from: '$edit.assets[0]', label: 'out' }] },
    }
    const problems = validatePlan(dag, lookup, {})
    expect(codesOf(problems)).toEqual(['PLAN_SLOT_CARDINALITY'])
    expect(problems[0].details).toMatchObject({
      slot: 'reference',
      cardinality: 'array',
      count: 3,
      max: 2,
    })
  })

  it('PLAN_SLOT_DUAL_SOURCE — one slot, two channels', () => {
    const dag = bicycle()
    dag.steps[2].input.references = { startFrame: 'image_1' }
    const codes = codesOf(validatePlan(dag, lookup, {}))
    expect(codes).toContain('PLAN_SLOT_DUAL_SOURCE')
  })

  it('PLAN_SLOT_REQUIRED_UNBOUND — the silent-wrong-image rule', () => {
    const problem = flip('PLAN_SLOT_REQUIRED_UNBOUND', (dag) => {
      dag.steps[2].assets = undefined
      dag.output.assets?.push({ from: '$render.assets[0]', label: 'still' })
    })
    expect(problem.details).toMatchObject({ slot: 'startFrame' })
  })

  it('a required slot satisfied through input.references is bound', () => {
    const dag = bicycle()
    dag.steps[2].assets = undefined
    dag.steps[2].input.references = { startFrame: 'image_1' }
    dag.output.assets?.push({ from: '$render.assets[0]', label: 'still' })
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })
})

describe('validatePlan — rule 21, PLAN_STEP_INPUT_INVALID', () => {
  it('catches a mistyped literal', () => {
    const problem = flip('PLAN_STEP_INPUT_INVALID', (dag) => {
      dag.steps[0].input.temperature = '0.7'
    })
    expect(problem.details).toMatchObject({ pattern: 'text-generation' })
    expect(problem.message).toContain('temperature')
  })

  it('suppresses issues that land on a ref-valued field', () => {
    // `n` is a number on meta_image-best-of-n; a ref there is only typed after
    // substitution, so the parse must not complain about it.
    const dag: PlanDag = {
      steps: [
        {
          id: 'hero',
          pattern: 'meta_image-best-of-n',
          input: {
            innerPatternId: 'text-to-image',
            innerInput: { prompt: '$input.prompt' },
            n: '$input.count',
            targetDescription: '$input.prompt',
          },
        },
      ],
      output: { assets: [{ from: '$hero.assets[label=winner]', label: 'hero' }] },
    }
    const problems = validatePlan(dag, lookup, {
      inputs: z.object({ prompt: z.string(), count: z.number() }),
    })
    expect(problems).toEqual([])
  })

  it('keeps unknown top-level keys — passthrough, exactly as dispatch does', () => {
    const dag = bicycle()
    dag.steps[1].input.size = '1024x1024'
    dag.steps[1].input.seed = 7
    dag.steps[1].input.providerOptions = { guidance: 3 }
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })

  it('is skipped for a step already refused as the plan itself', () => {
    const dag = bicycle()
    dag.steps[0].pattern = 'meta_plan'
    const codes = codesOf(validatePlan(dag, lookup, { selfId: 'meta_plan' }))
    expect(codes).not.toContain('PLAN_STEP_INPUT_INVALID')
  })
})

describe('validatePlan — rule 22, PLAN_STEP_UNUSED', () => {
  it('flags a step nothing reads', () => {
    const problem = flip('PLAN_STEP_UNUSED', (dag) => {
      dag.steps.push({ id: 'orphan', pattern: 'text-generation', input: { prompt: 'x' } })
    })
    expect(problem.details).toMatchObject({ stepId: 'orphan' })
  })

  it('an `output.values` entry counts as a reader', () => {
    const dag = bicycle()
    dag.steps.push({ id: 'extra', pattern: 'text-generation', input: { prompt: 'x' } })
    ;(dag.output.values as Record<string, string>).extra = '$extra.text'
    expect(validatePlan(dag, lookup, {})).toEqual([])
  })
})

describe('validatePlan — rule 23, PLAN_OUTPUT_LABEL_DUPLICATE', () => {
  it('flags two returned assets under one label', () => {
    const problem = flip('PLAN_OUTPUT_LABEL_DUPLICATE', (dag) => {
      dag.output.assets?.push({ from: '$render.assets[0]', label: 'clip' })
    })
    expect(problem.details).toMatchObject({ label: 'clip' })
    expect(problem.path).toEqual(['output', 'assets', 1, 'label'])
  })
})

describe('validatePlan — rule 24, PLAN_INPUT_NOT_SERIALISABLE', () => {
  it('flags a Date a host put in a step input', () => {
    const problem = flip('PLAN_INPUT_NOT_SERIALISABLE', (dag) => {
      ;(dag.steps[0].input as Record<string, unknown>).when = new Date()
    })
    expect(problem.path).toEqual(['steps', 0, 'input', 'when'])
  })

  it('flags an undefined array slot but not an undefined object property', () => {
    const withHole = bicycle()
    ;(withHole.steps[0].input as Record<string, unknown>).stopSequences = ['x', undefined]
    expect(codesOf(validatePlan(withHole, lookup, {}))).toContain(
      'PLAN_INPUT_NOT_SERIALISABLE',
    )

    const withDrop = bicycle()
    ;(withDrop.steps[0].input as Record<string, unknown>).topP = undefined
    expect(validatePlan(withDrop, lookup, {})).toEqual([])
  })

  it('mirrors every refusal canonicalise makes', () => {
    // canonicalise lives in @orchestral/runtime, which core cannot import, so
    // this list is the hand-maintained twin — keep it in step with
    // idempotency.ts.
    const refused: Record<string, unknown> = {
      map: new Map(),
      set: new Set(),
      date: new Date(),
      big: 10n,
      fn: () => undefined,
      sym: Symbol('x'),
      inf: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
    }
    for (const [key, bad] of Object.entries(refused)) {
      const dag = bicycle()
      ;(dag.steps[0].input as Record<string, unknown>).v = bad
      expect(codesOf(validatePlan(dag, lookup, {})), key).toEqual([
        'PLAN_INPUT_NOT_SERIALISABLE',
      ])
    }
  })

  it('reports a cyclic host-constructed input instead of blowing the stack', () => {
    const dag = bicycle()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    ;(dag.steps[0].input as Record<string, unknown>).providerOptions = cyclic
    let problems: PlanProblem[] = []
    expect(() => {
      problems = validatePlan(dag, lookup, {})
    }).not.toThrow()
    expect(codesOf(problems)).toEqual(['PLAN_INPUT_NOT_SERIALISABLE'])
  })

  it('reports a pathologically deep input instead of blowing the stack', () => {
    const dag = bicycle()
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 20_000; i++) deep = { next: deep }
    ;(dag.steps[0].input as Record<string, unknown>).providerOptions = deep
    expect(codesOf(validatePlan(dag, lookup, {}))).toEqual([
      'PLAN_INPUT_NOT_SERIALISABLE',
    ])
  })
})

describe('validatePlan — accumulation', () => {
  it('five distinct mistakes yield five problems in one call', () => {
    const dag = {
      steps: [
        { id: 'a', pattern: 'text-generation', input: { prompt: 'one' } },
        { id: 'a', pattern: 'text-generation', input: { prompt: 'two' } },
        { id: 'b', pattern: 'text-to-hologram', input: { prompt: '$a.text' } },
        { id: 'c', pattern: 'text-generation', input: { prompt: '$nope.text' } },
        { id: 'd', pattern: 'text-generation', input: { prompt: 'four' } },
      ],
      output: {
        assets: [
          { from: '$b.assets[0]', label: 'x' },
          { from: '$b.assets[0]', label: 'x' },
        ],
        values: { v: '$c.text' },
      },
    } as unknown as PlanDag
    const problems = validatePlan(dag, lookup, {})
    expect(codesOf(problems).sort()).toEqual(
      [
        'PLAN_OUTPUT_LABEL_DUPLICATE',
        'PLAN_PATTERN_NOT_FOUND',
        'PLAN_REF_UNKNOWN_STEP',
        'PLAN_STEP_ID_DUPLICATE',
        'PLAN_STEP_UNUSED',
      ].sort(),
    )
  })

  it('never throws on a dag that is not a dag', () => {
    for (const junk of [null, 42, 'nope', [], { steps: 'not-an-array' }]) {
      expect(() => validatePlan(junk as unknown as PlanDag, lookup, {})).not.toThrow()
    }
  })
})

describe('assertPlanValid', () => {
  it('passes a clean plan', () => {
    expect(() => assertPlanValid(bicycle(), lookup, {})).not.toThrow()
  })

  it('throws PlanInvalidError carrying every problem', () => {
    const dag = bicycle()
    dag.steps[1].input.prompt = '$nosuch.text'
    dag.output.assets?.push({ from: '$render.assets[0]', label: 'clip' })
    try {
      assertPlanValid(dag, lookup, {})
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PlanInvalidError)
      const e = err as PlanInvalidError
      expect(e.code).toBe('PLAN_INVALID')
      expect(codesOf(e.details.problems).sort()).toEqual([
        'PLAN_OUTPUT_LABEL_DUPLICATE',
        'PLAN_REF_UNKNOWN_STEP',
      ])
      expect(e.message).toContain('PLAN_REF_UNKNOWN_STEP')
    }
  })
})

describe('planRefine through the real dispatch path', () => {
  /**
   * The claim being proved: a plan meta needs NO new hook to get walk problems
   * to the model. `resolveDispatchTarget` applies `.passthrough()` and
   * `safeParse`s (dispatch-pattern.ts:198-202); on zod 4.4.3 that preserves the
   * superRefine and reports its issues with their paths, so the walk arrives
   * through the existing INPUT_VALIDATION_FAILED tool result.
   */
  function registryWithPlanMeta(): PatternRegistry {
    const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
    for (const pattern of [
      textGenerationStub,
      textToImageStub,
      imageToVideoStub,
    ] as unknown as Pattern[]) {
      registry.add(pattern)
    }
    const refined = PlanDagSchema.superRefine(
      planRefine(registry, { selfId: 'meta_plan', audience: 'agent-loop' }),
    )
    registry.add({
      ...planMetaStub,
      tool: { ...planMetaStub.tool, inputs: refined },
    } as unknown as Pattern)
    return registry
  }

  it('reports walk problems as INPUT_VALIDATION_FAILED issues with their paths', () => {
    const registry = registryWithPlanMeta()
    const dag = bicycle()
    dag.steps[1].input.prompt = '$describe.output'
    const result = resolveDispatchTarget(
      registry,
      { pattern_id: 'meta_plan', input: dag as unknown as Record<string, unknown> },
      'agent-loop',
    )
    expect(result).toMatchObject({ code: 'INPUT_VALIDATION_FAILED' })
    const issues = (result as { issues: readonly z.core.$ZodIssue[] }).issues
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toEqual(['steps', 1, 'input', 'prompt'])
    const params = (issues[0] as { params?: { code?: string } }).params
    expect(params?.code).toBe('PLAN_REF_PATH_UNKNOWN')
  })

  it('lets a clean plan through the same path', () => {
    const registry = registryWithPlanMeta()
    const result = resolveDispatchTarget(
      registry,
      {
        pattern_id: 'meta_plan',
        input: bicycle() as unknown as Record<string, unknown>,
      },
      'agent-loop',
    )
    expect(result).not.toMatchObject({ code: 'INPUT_VALIDATION_FAILED' })
    expect((result as { pattern: Pattern }).pattern.id).toBe('meta_plan')
  })

  it('carries several problems in one tool result', () => {
    const registry = registryWithPlanMeta()
    const dag = bicycle()
    dag.steps[1].input.prompt = '$describe.output'
    dag.steps[2].assets = undefined
    dag.output.assets?.push({ from: '$render.assets[0]', label: 'still' })
    const result = resolveDispatchTarget(
      registry,
      { pattern_id: 'meta_plan', input: dag as unknown as Record<string, unknown> },
      'agent-loop',
    )
    const issues = (result as { issues: readonly z.core.$ZodIssue[] }).issues
    expect(
      issues.map((i) => (i as { params?: { code?: string } }).params?.code).sort(),
    ).toEqual(['PLAN_REF_PATH_UNKNOWN', 'PLAN_SLOT_REQUIRED_UNBOUND'])
  })
})
