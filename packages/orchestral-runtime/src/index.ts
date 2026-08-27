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

// Preflight — what a plan would cost, routed but not run — moved to
// @orchestral/plan with the rest of the feature. It takes the same
// `ResolveCtxProvider` this package's `InlineRuntimeInit` takes, so the report
// names the model the run would pick:
//
//   import { preflightPlan } from '@orchestral/plan'

// The shape a declined alternative is reported in on ALTERNATIVES_NOT_ENABLED's
// diagnostic (which reaches a host as `JobError.details.diagnostic`). The error
// class itself stays internal — hosts narrow on `JobError.code` — but this is
// the payload they read. Defined in @orchestral/core, where the selection that
// produces it is; re-exported here because this is where the error is.
export type { AvailableAlternative } from './alternatives'
