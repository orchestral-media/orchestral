// @orchestral/agent — the optional agent extension: the first-party
// AgentPatterns plus the reference in-process runner that drives their loop.
//
// Agent support is NOT part of the core surface. `@orchestral/core` defines the
// contract types (AgentPattern, the finish envelope, agentInputSchema) and
// `@orchestral/runtime` carries the dormant seam (dispatchAgent + AgentRunImpl,
// inert until a host injects a runner) — together, everything a host needs to
// write its own agent. This package is what you install when you want the
// first-party ones instead. Nothing in @orchestral/core, @orchestral/runtime or
// @orchestral/patterns depends on it.

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

// ── Reference AgentRunImpl ───────────────────────────────────────────────
// The in-process ai-sdk tool-loop. `ai` is a PEER dependency — orchestral
// ships no provider SDK, the host brings its own (and its own key).
export {
  createInProcessAgentRunImpl,
  type AgentRunDeps,
  type LanguageModelInstance,
} from './in-process-run'
