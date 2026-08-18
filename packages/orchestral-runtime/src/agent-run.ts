// AgentRunImpl — host injection point for AgentPattern's LLM loop.
//
// dispatchAgent (in inline.ts) does not know about ai-sdk / Anthropic SDK /
// OpenAI SDK / etc. It calls AgentRunImpl.run() once per AgentPattern
// dispatch. Host provides the concrete implementation (typical: ai-sdk
// ToolLoopAgent over IPC to a worker process; alternatives: any class
// implementing ai-sdk's Agent v1 interface).
//
// No ai-sdk import here — `messages` is opaque pass-through (host casts to
// ModelMessage at the boundary); `tools` carries IPC-friendly descriptors.
//
// ## Implementing AgentRunImpl
//
// The type signature does not express these four rules, and every one of them
// fails silently when broken. Read them before writing an implementation.
//
// 1. **Map `system` onto your SDK's system-prompt field.** The argument is
//    named `system` because that is the ground truth across Anthropic
//    Messages, OpenAI Chat, and Gemini systemInstruction. ai-sdk's
//    ToolLoopAgent calls the same thing `instructions` — a one-line rename at
//    the constructor. Drop it and the Pattern author's `loop.system` never
//    reaches the model, which reads as "the agent ignores its brief".
//
// 2. **Intercept host tools before `onToolCall`.** Tools the host injects into
//    the loop (its own non-Pattern tools) must be executed by the
//    implementation itself when wrapping them for the SDK. `onToolCall`
//    belongs to the runtime and only understands `find_pattern`,
//    `dispatch_pattern`, and inline-core Pattern ids — anything else falls
//    through to an `UNKNOWN_TOOL` result the LLM then has to recover from.
//
// 3. **Pass `finishToolName` through as an ordinary descriptor.** It arrives
//    both as a named argument (so budget / nudge logic can key on it) and as
//    a normal entry in `tools`. Do not special-case its execution: the
//    runtime's `onToolCall` is what terminates the run and resolves the
//    declared outputs. Intercepting it host-side strands the loop.
//
// 4. **`onToolCall`'s resolved value is the tool result the LLM sees.** Feed
//    it back into the loop's message history verbatim. It resolves — never
//    rejects — for recoverable failures: the runtime returns a structured
//    error object precisely so the LLM can self-correct and continue. Turning
//    a resolved error object into a thrown exception kills runs the loop was
//    designed to survive.

import type {
  AgentToolDescriptor as CatalogAgentToolDescriptor,
  ModelTag,
  ResolveContext,
} from '@orchestral/core'

/**
 * Opaque chat message shape — runtime does not inspect bodies, just
 * passes to AgentRunImpl which casts to whatever SDK's message type
 * (e.g. ai-sdk ModelMessage). Defined here so @orchestral/runtime stays
 * SDK-agnostic.
 *
 * @alpha
 */
export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
}

/**
 * Tool descriptor handed to AgentRunImpl. Reuses
 * `@orchestral/core`'s `AgentToolDescriptor` (single canonical shape)
 * plus an extension for base tools (`base.*` patternId prefix). Re-
 * exported here so AgentRunImpl implementations only import from
 * `@orchestral/runtime`.
 */
export type AgentToolDescriptor = CatalogAgentToolDescriptor

/**
 * One step the LLM took inside a loop iteration. Surfaces tool calls
 * the LLM emitted, the model's textual output, and usage rolled to that
 * step. AgentRunImpl emits these via `onStepFinish` for host progress UI.
 *
 * `input?` is optional because the wire-format `z.unknown()` infers to
 * an optional field; treat as unknown-or-missing on the consumer side.
 *
 * @alpha
 */
export interface AgentLoopStep {
  stepIndex: number
  toolCalls: readonly { name: string; input?: unknown }[]
  text: string
  usage?: { totalTokens?: number }
}

/**
 * Host-injected LLM loop executor. Single contact surface between this
 * runtime and any LLM SDK. `dispatchAgent` calls `run()` exactly once
 * per AgentPattern dispatch and feeds the returned outputs back to the
 * Pattern's caller.
 *
 * Implementations:
 *   • A desktop host: wraps an SDK tool-loop agent over IPC to a worker
 *     process
 *   • Tests: in-memory mock returning canned step transcripts
 *   • Custom hosts: any LLM SDK implementing a tool-loop semantically
 *     equivalent to ai-sdk Agent v1
 *
 * @alpha
 */
export interface AgentRunImpl {
  run(args: {
    /**
     * System prompt for the loop's LLM. The runtime uses `system` (matches
     * Anthropic Messages / OpenAI Chat / Gemini systemInstruction
     * ground truth). Implementations using ai-sdk must map this to
     * ToolLoopAgent's `instructions` constructor field (rule 1 above).
     */
    system: string

    /**
     * Id of the AgentPattern being dispatched — pattern vocabulary, not host
     * vocabulary. The host uses it to resolve the per-agent host-tool surface
     * (agent-tool grants). The runtime forwards `pattern.id`; it never sends
     * host tool names.
     */
    patternId: string

    /**
     * Asset-ledger context host tools must record produced assets into. Equals
     * the runtime's agent context id — the handle namespace the finish broker
     * resolves deliverable handles against. A host that records under any other
     * id mints handles the finish tool can never see, so a host-tool deliverable
     * either fails to resolve or (worse) collides with a handle minted earlier
     * in the real context.
     */
    runContextId: string

    /**
     * Conversation history. Required — Agent is stateless, host owns
     * message persistence. AgentRunImpl passes via ai-sdk's `messages`
     * field (mutually exclusive with `prompt`, which we never use for
     * chat scenarios).
     */
    messages: readonly AgentChatMessage[]

    /**
     * Catalog subset visible to this loop's LLM. Scoped by dispatchAgent from
     * loop.toolPatternIds; host tools are injected host-side, keyed by
     * patternId. Implementation wraps each into an ai-sdk Tool whose execute
     * closure calls `onToolCall`.
     */
    tools: readonly AgentToolDescriptor[]

    /** Forwarded to host's model resolver (router.resolve via modelTags). */
    modelTags: readonly ModelTag[]

    /** Forwarded to host's model resolver. */
    resolveCtx?: ResolveContext

    /**
     * Chat session that dispatched this agent, when any. Host model
     * resolution may use it for session-scoped overrides (session model
     * assignments / chat-model fallback). Absent for host-only dispatches
     * with no chat session.
     */
    sessionId?: string

    /** Parent dispatch signal — must cascade into LLM call abort. */
    abortSignal: AbortSignal

    /** Optional wall-clock cap (ms). Maps directly to ai-sdk timeout. */
    timeout?: number

    /**
     * Name of the runtime-injected finish tool (from core's
     * AGENT_FINISH_TOOL_NAME). Forward to the loop layer so nudge / budget
     * attribution can key on it. The finish tool itself is a plain descriptor
     * in `tools` — do NOT intercept it host-side; route through onToolCall
     * (rule 3 in "Implementing AgentRunImpl" above).
     */
    finishToolName: string

    /**
     * Reverse hook — implementation calls this when the LLM emits a
     * tool call. Runtime recurses into submitJob (atomic / meta / agent)
     * for Pattern tools; host tools are intercepted host-side by
     * AgentRunImpl before this hook fires (rule 2 above), so this path only
     * sees find_pattern / dispatch_pattern / Pattern names.
     *
     * The resolved value IS the tool result the LLM sees — feed it back into
     * the message history verbatim, including structured error objects, which
     * resolve rather than reject so the LLM can self-correct (rule 4 above).
     * The loop continues until the host's stop policy fires (the host owns the
     * stop condition; this runtime does not declare it).
     */
    onToolCall: (call: {
      name: string
      input: unknown
      callId: string
    }) => Promise<unknown>

    /** Optional progress hook — host fans out as Job events. */
    onStepFinish?: (step: AgentLoopStep) => void
  }): Promise<{
    /** Final text from LLM after last step (for natural-finish path). */
    text: string
    /** Total usage rolled up across all steps. */
    usage?: { totalTokens?: number }
  }>
}
