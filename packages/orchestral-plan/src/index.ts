// @orchestral/plan — a pipeline authored as data: the schema, the walk, the
// interpreter and the preflight, in one package.
//
// Why one package and not three: the primitive underneath all four is "read a
// `$ref` off a step's input", and it used to be copied once per package. See
// src/refs.ts.

// ── The wire schema the model fills ──────────────────────────────────────
export {
  PLAN_ASSET_REF_RE,
  PLAN_INPUT_ASSET_REF_RE,
  PLAN_STEP_ID_RE,
  PLAN_VALUE_REF_RE,
  PlanDagSchema,
  PlanOutputSchema,
  PlanRetrySchema,
  PlanStepSchema,
  type PlanDag,
  type PlanOutput,
  type PlanRetry,
  type PlanStep,
} from './plan'

// ── Layer 1: every problem in a DAG, before any money is spent ───────────
export {
  assertPlanValid,
  planRefine,
  PlanInvalidError,
  validatePlan,
  type PlanPatternLookup,
  type PlanProblem,
  type PlanProblemCode,
  type PlanValidateOptions,
} from './validate'

// ── The interpreter: a DAG, executed as an ordinary meta ─────────────────
export {
  PLAN_PATTERN_ID,
  PLAN_TOOL_DESCRIPTION,
  createPlanMeta,
  planToMeta,
  runPlan,
  type PlanMetaPattern,
  type PlanStepIdentity,
  type PlanToMetaOptions,
  type RunPlanOptions,
} from './interpreter'

// ── Preflight: what a plan would cost, routed but not run ────────────────
export {
  formatPlanPreflight,
  preflightPlan,
  type PlanPreflightDeps,
  type PlanPreflightReport,
  type PlanPreflightStep,
  type PlanStepRouting,
  type PreflightAlternative,
} from './preflight'
