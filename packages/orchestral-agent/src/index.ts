// @orchestral/agent — the optional agent extension: the two first-party
// AgentPatterns, and nothing else.
//
// Agent support is NOT part of the core surface. `@orchestral/core` defines the
// contract types (AgentPattern, the finish envelope, agentInputSchema) and
// `@orchestral/runtime` carries the dormant seam (dispatchAgent + AgentRunImpl,
// inert until a host injects a runner) — together, everything a host needs to
// write its own agent. This package is what you install when you want the
// first-party ones instead. Nothing in @orchestral/core, @orchestral/runtime or
// @orchestral/patterns depends on it.
//
// The tool-loop driver is deliberately absent. Like `ModelCapability.call`,
// AgentRunImpl is a seam the library declares and the host fills: shipping a
// loop here would mean shipping an agent-framework choice (and its provider
// SDK) inside a pattern catalog. A copy-paste reference implementation over the
// ai-sdk ToolLoopAgent lives in examples/agent-hello-world/src/agent-runner.ts.
// This package's only runtime dependency surface is zod + the workspace ones.

// ── First-party AgentPatterns ────────────────────────────────────────────
export {
  AGENT_LONG_FORM_VIDEO_PATTERN_ID,
  AgentLongFormVideoInputSchema,
  createLongFormVideoAgent,
  type AgentLongFormVideoInput,
} from './long-form-video'

export {
  AGENT_ORCHESTRATOR_PATTERN_ID,
  OrchestratorInputSchema,
  createOrchestratorAgent,
  type OrchestratorInput,
} from './orchestrator'
