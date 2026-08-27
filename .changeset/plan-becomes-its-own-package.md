---
'@orchestral/plan': minor
'@orchestral/core': minor
'@orchestral/patterns': minor
'@orchestral/runtime': minor
---

The plan feature becomes one package, `@orchestral/plan`.

A plan used to be spread over three: the wire schema and `validatePlan` in
`@orchestral/core`, `planToMeta` in `@orchestral/patterns`, `preflightPlan` in
`@orchestral/runtime`. The primitive underneath all three — "read a `$ref` off a
step's input" — existed three times, with three depth rules and two head filters
between them, and two of the copies carried a comment asking a human to keep
them in step. What those comments guarded is the plan's central promise: the
string layer 1 validates is the string the interpreter substitutes and the
string preflight bills for. It is one function now (`refs.ts`), and the promise
is a call rather than a discipline. Core also sheds its largest file — a
1300-line wire-format validator that served exactly one Pattern.

Breaking, and what to do about it:

- `@orchestral/core` no longer exports `PlanDagSchema`, `PlanStepSchema`,
  `PlanRetrySchema`, `PlanOutputSchema`, the three `PLAN_*_RE` regexes,
  `validatePlan`, `assertPlanValid`, `planRefine`, `PlanInvalidError`, or the
  `PlanDag` / `PlanStep` / `PlanRetry` / `PlanOutput` / `PlanProblem` /
  `PlanProblemCode` / `PlanPatternLookup` / `PlanValidateOptions` types. Import
  them from `@orchestral/plan`; the shapes are unchanged.
- `@orchestral/runtime` no longer exports `preflightPlan`,
  `formatPlanPreflight`, `PlanPreflightDeps`, `PlanPreflightReport`,
  `PlanPreflightStep`, `PlanStepRouting` or `PreflightAlternative`. Import them
  from `@orchestral/plan` and add it to your dependencies. The signatures are
  unchanged — including `deps.resolveCtx`, which is still the same provider you
  hand `InlineRuntimeInit.resolveCtxProvider`.
- `@orchestral/patterns` no longer exports `planToMeta`, `runPlan`,
  `PLAN_TOOL_DESCRIPTION`, `PlanMetaPattern`, `PlanToMetaOptions` or
  `RunPlanOptions`. Import them from `@orchestral/plan`; nothing else changes.
  It still exports `createPlanMeta` and `PLAN_PATTERN_ID`, because this package
  still ships `meta_plan` — its manifest names that factory, and the id is a
  member of `FIRST_PARTY_PATTERN_IDS.meta`. Both now come from
  `@orchestral/plan`, which this package depends on; you get it transitively.

Also moved, without a change in behaviour: `sumCosts` now lives in
`@orchestral/core` beside `metaEnvelopeShape.cost`, whose null rule it
implements (`@orchestral/patterns` re-exports it, so nothing to do);
`applicableAlternatives`, `pickAlternative`, `toAvailableAlternative` and
`readRequiresSemantics` are core's, because deciding whether a declared path
applies is a read of the registry and the router while taking one is runtime
policy — the runtime's ALTERNATIVES_NOT_ENABLED diagnostic and a plan's
preflight now report from the same evaluation instead of two copies of it.
`ResolveCtxProvider` is core's for the same reason: preflight and
`InlineRuntimeInit` take the same provider, so it is a contract rather than one
substrate's detail. `@orchestral/runtime` still re-exports it and
`AvailableAlternative`, so those two imports are unaffected.

One behaviour change, and it is unreachable in a valid plan: the interpreter's
dependency walk used to have no depth limit while the other two capped at 64.
All three cap at 64 now. `validatePlan`'s rule 24 already refuses an input
nested deeper than that, so no plan that validates can tell the difference.
