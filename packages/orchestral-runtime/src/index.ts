// @orchestral/runtime — in-process Runtime implementation for @orchestral/core.

export {
  InlineRuntime,
  InlineRuntimeAdapter,
  type AgentAssetBridge,
  type InlineRuntimeInit,
  type ResolveCtxProvider,
  type TransientFailureInfo,
  type TransientRetryConfig,
} from './inline'

export { forkExecutionContext } from './fork-context'

export {
  deriveIdempotencyKey,
  IdempotencyNotSerialisableError,
  type DeriveIdempotencyKeyInput,
} from './idempotency'

export type {
  AgentRunImpl,
  AgentChatMessage,
  AgentToolDescriptor,
  AgentLoopStep,
} from './agent-run'

export { resolveAssets } from './asset-resolution'

// ── Preflight ────────────────────────────────────────────────────────────
// What a plan would cost, routed but not run: `validatePlan` plus a routing
// decision per step, computed with the host's own resolveCtx provider and the
// runtime's own Alternative machinery — which is why it lives here and not in
// core beside the rest of the plan contract.
export {
  formatPlanPreflight,
  preflightPlan,
  type PlanPreflightDeps,
  type PlanPreflightReport,
  type PlanPreflightStep,
  type PlanStepRouting,
  type PreflightAlternative,
} from './preflight-plan'

// The shape a declined alternative is reported in, on `PlanStepRouting` here
// and on ALTERNATIVES_NOT_ENABLED's diagnostic (which reaches a host as
// `JobError.details.diagnostic`). The error class itself stays internal —
// hosts narrow on `JobError.code` — but this is the payload they read.
export type { AvailableAlternative } from './alternatives'
