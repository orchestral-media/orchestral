// @orchestral/runtime — in-process Runtime implementation for @orchestral/core.

export {
  InlineRuntime,
  InlineRuntimeAdapter,
  type AgentAssetBridge,
  type InlineRuntimeInit,
  type ResolveCtxProvider,
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
