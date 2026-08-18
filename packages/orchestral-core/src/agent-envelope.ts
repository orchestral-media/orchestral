// AgentDispatchEnvelope — metadata envelope returned from agent dispatch.
//
// The parent LLM consumes the typed `output` field (parsed via `pattern.outputs`),
// the parent host code consumes the metadata envelope (tool counts, usage, etc.).
// It's exposed as a sidecar via the optional `Runtime.getAgentEnvelope(jobId)`
// rather than by widening Job.output, so the Job shape stays uniform across
// pattern kinds and only callers that want the metadata pay for it.

/**
 * Envelope of metadata captured during one AgentPattern dispatch.
 * Stored under the dispatch's `jobId` and retrievable via
 * `runtime.getAgentEnvelope?.(jobId)` after the job settles — the accessor is
 * optional on Runtime, so feature-detect before calling.
 *
 * @alpha
 */
export interface AgentDispatchEnvelope {
  /** Pattern.id that was dispatched (e.g. 'agent_director'). */
  patternId: string

  /**
   * Final assistant text from the agent loop's last natural-finish step.
   * Useful for parents that want to surface the LLM's narration alongside
   * the structured `outputs`.
   */
  text: string

  /** 'completed' on natural finish; 'errored' if the dispatch threw. */
  status: 'completed' | 'errored'

  /** Number of tool calls the LLM emitted across the entire loop. */
  totalToolUseCount: number

  /** Wall-clock duration of the dispatch (ms). */
  totalDurationMs: number

  /**
   * Rolled-up usage from the agent loop's LLM calls. Shape mirrors
   * `AgentRunImpl.run`'s `result.usage` (currently `totalTokens` only;
   * input_tokens / output_tokens require AgentRunImpl to expose them
   * separately, which is not yet implemented).
   */
  usage?: { totalTokens?: number }

  /**
   * Sidecar pointer for transcript lookup. Both fields are set when a
   * transcriptStore was injected and the dispatch wrote at least one message.
   * Host calls `transcriptStore.read(runId, transcriptId)` (or `readAll(runId,
   * patternIdPrefix)`) to pull the full message history.
   */
  runId?: string
  /** agentId of this dispatch — format `${pattern.id}#${uuid}`. */
  transcriptId?: string

  /** Error message when status='errored'. */
  errorMessage?: string
}
