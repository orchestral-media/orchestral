// TranscriptStore — subagent message transcript persistence.
//
// Responsibility layering:
//   • This interface is defined in `@orchestral/core` — substrate-agnostic
//   • `@orchestral/runtime` dispatchAgent calls `store.append(...)` to write
//     the transcript from the AgentRunImpl step-completion callback
//   • The default implementation `InMemoryTranscriptStore` uses an in-process
//     Map (dev / test; lost when the process exits)
//   • A production host can swap in a `SqliteTranscriptStore` that persists to
//     an `agent_transcripts` table, readable across processes
//
// Write semantics:
//   • Append-only, seq is 0-based and monotonically increasing
//   • Written at message boundaries (a complete step finishes), not per SSE
//     token delta — only recordable message kinds are persisted
//   • Crash recovery / async resume (JobSpec.resumeFromRunId) reads the full
//     transcript by `(runId, agentId)`

/**
 * Shape of a single message in a transcript. The `raw` field is preserved
 * byte-exact so a future Anthropic Extended Thinking reasoning round-trip can
 * use it; this layer neither interprets nor transforms it.
 */
export interface TranscriptMessage {
  /** Sequence number within this (runId, agentId) transcript, 0-based and monotonic. */
  seq: number
  /** Receive time (epoch ms). */
  ts: number
  /** Message kind — the recordable message kinds kept after filtering. */
  kind:
    | 'assistant' // complete LLM response (may include text + tool_use blocks)
    | 'tool-result' // tool execution result fed back into the LLM context
    | 'progress' // progress event
    | 'compact-boundary' // context-compaction boundary marker
  /**
   * Raw message payload. This layer does not prescribe a shape; the host
   * stores it according to its LLM SDK abstraction (an Anthropic message, an
   * ai-sdk LoopStep, a custom envelope, etc.). A reasoning round-trip needs
   * reasoning blocks preserved byte-exact, so the host implementation chooses
   * its own persistence format (JSON.stringify / msgpack / etc.).
   */
  raw: unknown
}

/** Read shape including agentId, used by readAll() for resume across agents. */
export interface TranscriptMessageWithAgent extends TranscriptMessage {
  agentId: string
}

export interface TranscriptStore {
  /**
   * Append a message to the (runId, agentId) transcript. `seq` is monotonic
   * within the store; the implementation is responsible for uniqueness
   * (a sqlite PRIMARY KEY or an in-memory length++).
   */
  append(
    runId: string,
    agentId: string,
    msg: TranscriptMessage,
  ): Promise<void>

  /**
   * Read all messages for (runId, agentId), in ascending seq order. On resume,
   * dispatchAgent uses this plus the new prompt to assemble seedMessages.
   */
  read(
    runId: string,
    agentId: string,
  ): Promise<readonly TranscriptMessage[]>

  /**
   * Read **all** messages under `runId` (across agentIds), ordered by
   * `(agentId, seq)`. On resume, dispatchAgent uses this to reassemble the full
   * history of the relevant agents under the same runId. When
   * filterPatternIdPrefix is provided, only rows whose agentId starts with that
   * prefix are returned (typical use: `${pattern.id}#`, to take only the
   * sub-agent dispatch history of the same pattern).
   */
  readAll(
    runId: string,
    filterPatternIdPrefix?: string,
  ): Promise<readonly TranscriptMessageWithAgent[]>

  /**
   * Clear all transcripts under a runId (possibly across multiple agentIds).
   * Called as a cascade when a job is deleted; without that hook the store may
   * still accumulate.
   */
  clear(runId: string): Promise<void>
}

/**
 * In-process Map implementation. For dev / test; lost when the process exits.
 *
 * A production host can inject a `SqliteTranscriptStore` instead. Both
 * implement the same `TranscriptStore` interface, so dispatchAgent-side code
 * needs no branching.
 */
export class InMemoryTranscriptStore implements TranscriptStore {
  // Key = `${runId}::${agentId}`
  private readonly transcripts = new Map<string, TranscriptMessage[]>()

  private key(runId: string, agentId: string): string {
    return `${runId}::${agentId}`
  }

  async append(
    runId: string,
    agentId: string,
    msg: TranscriptMessage,
  ): Promise<void> {
    const k = this.key(runId, agentId)
    const arr = this.transcripts.get(k)
    if (arr) {
      arr.push(msg)
    } else {
      this.transcripts.set(k, [msg])
    }
  }

  async read(
    runId: string,
    agentId: string,
  ): Promise<readonly TranscriptMessage[]> {
    return this.transcripts.get(this.key(runId, agentId)) ?? []
  }

  async readAll(
    runId: string,
    filterPatternIdPrefix?: string,
  ): Promise<readonly TranscriptMessageWithAgent[]> {
    const prefix = `${runId}::`
    const collected: TranscriptMessageWithAgent[] = []
    for (const [k, msgs] of this.transcripts) {
      if (!k.startsWith(prefix)) continue
      const agentId = k.slice(prefix.length)
      if (filterPatternIdPrefix && !agentId.startsWith(filterPatternIdPrefix))
        continue
      for (const m of msgs) {
        collected.push({ ...m, agentId })
      }
    }
    // Stable order — agentId asc, then seq asc inside each
    collected.sort(
      (a, b) =>
        a.agentId === b.agentId ? a.seq - b.seq : a.agentId < b.agentId ? -1 : 1,
    )
    return collected
  }

  async clear(runId: string): Promise<void> {
    // Iterate and delete all entries for this runId across all agentIds
    const prefix = `${runId}::`
    for (const k of this.transcripts.keys()) {
      if (k.startsWith(prefix)) {
        this.transcripts.delete(k)
      }
    }
  }
}
