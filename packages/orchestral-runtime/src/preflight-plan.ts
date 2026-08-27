// Moved to @orchestral/plan. Kept here for one commit so the migration lands
// green; the follow-up removes it, together with this package's dependency on
// @orchestral/plan.
export {
  formatPlanPreflight,
  preflightPlan,
  type PlanPreflightDeps,
  type PlanPreflightReport,
  type PlanPreflightStep,
  type PlanStepRouting,
  type PreflightAlternative,
} from '@orchestral/plan'
