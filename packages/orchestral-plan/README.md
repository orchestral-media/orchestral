# @orchestral/plan

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

A **plan** is a meta whose `compose` has been replaced by a list of steps, each
one a `ctx.step` call written down as `{ id, pattern, input, assets }` with
`$`-references between them. This package is that feature, whole:

| Export | What it is |
| --- | --- |
| `PlanDagSchema`, the three `$ref` regexes, `PlanOutputSchema` | the wire schema a model fills |
| `validatePlan` / `assertPlanValid` / `planRefine` | layer 1 — every problem in a DAG, before any money is spent |
| `planToMeta` / `runPlan` / `createPlanMeta` | the interpreter that executes a DAG as an ordinary meta |
| `preflightPlan` / `formatPlanPreflight` | what a plan would cost, routed but not run |

```sh
npm install @orchestral/plan @orchestral/core zod
```

You usually get it transitively — `@orchestral/patterns` depends on it to
register `meta_plan`. Install it directly to build a persisted plan package, or
to preflight a DAG before `submitJob`.

## Why one package

The primitive underneath all four is "read a `$ref` off a step's input". It used
to exist three times — once beside `validatePlan` in core, once in the
interpreter, once in preflight — each with its own depth rule and its own head
filter, and two of the three carried a comment asking a human to keep them in
step. What those comments were guarding is the plan's central promise: *the
string layer 1 validates must be the string the interpreter substitutes and the
string preflight bills for*. It is `src/refs.ts` now, and that promise is a
function call rather than a discipline.

The dependency arrow is unchanged and one-way: this package depends on
`@orchestral/core` and nothing else.
