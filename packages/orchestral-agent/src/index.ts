// @orchestral/agent — the optional agent extension: the first-party
// AgentPattern, and nothing else.
//
// Agent support is NOT part of the core surface. `@orchestral/core` defines the
// contract types (AgentPattern, the finish envelope, agentInputSchema) and
// `@orchestral/runtime` carries the dormant seam (dispatchAgent + AgentRunImpl,
// inert until a host injects a runner) — together, everything a host needs to
// write its own agent. This package is what you install when you want the
// first-party one instead. Nothing in @orchestral/core, @orchestral/runtime or
// @orchestral/patterns depends on it. (A second agent, the novel → video
// director, is kept as a reference host in examples/long-form-video rather than
// published here.)
//
// The tool-loop driver is deliberately absent. Like `ModelCapability.call`,
// AgentRunImpl is a seam the library declares and the host fills: shipping a
// loop here would mean shipping an agent-framework choice (and its provider
// SDK) inside a pattern catalog. A copy-paste reference implementation over the
// ai-sdk ToolLoopAgent lives in examples/agent-hello-world/src/agent-runner.ts.
// This package's only runtime dependency surface is zod + the workspace ones.

// ── First-party AgentPattern ─────────────────────────────────────────────
// Shipped as an overridable default, not a fixture: the prompt constant, the
// prompt-override type and the init are all exported, so adjusting this
// agent's tone, tool universe or abort policy costs a factory argument rather
// than a fork — the same deal @orchestral/patterns gives every shipped meta.
export {
  AGENT_ORCHESTRATOR_PATTERN_ID,
  ORCHESTRATOR_DEFAULT_PROMPTS,
  OrchestratorInputSchema,
  createOrchestratorAgent,
  type OrchestratorAgentInit,
  type OrchestratorInput,
  type OrchestratorPromptOverrides,
} from './orchestrator'
