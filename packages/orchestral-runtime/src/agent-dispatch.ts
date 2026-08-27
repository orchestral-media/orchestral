// Agent-kind dispatch: hand a Pattern's tool loop to the host's AgentRunImpl
// and broker what the loop asks for.
//
// The runtime does not implement a loop — `AgentRunImpl` is the seam, the same
// way `ModelCapability.call` is the seam for a model call. What lives here is
// everything around that seam: the catalog the loop is allowed to see, the
// recursion guards (agent-ancestor depth, the sub-agent blocklist, the visited
// cycle check), asset brokering through `AgentAssetBridge`, the finish
// contract, and the envelope a host reads back with `getAgentEnvelope`.

import {
  AGENT_FINISH_TOOL_NAME,
  buildAlwaysLoadDescriptors,
  buildCatalogDescriptors,
  buildFinishDescriptor,
  DEFAULT_AGENT_FINISH_SPEC,
  DispatchPatternInputSchema,
  FindPatternInputSchema,
  isDispatchError,
  matchSubagentBlocklist,
  projectToolOutputForModel,
  resolveDispatchTarget,
  sanitizeToolOutput,
} from '@orchestral/core'
import type {
  AgentDispatchEnvelope,
  AssetNeed,
  AgentPattern,
  AgentToolDescriptor,
  BuildCatalogDescriptorsOptions,
  CapabilityRouter,
  DiagnosticsLogger,
  DispatchContext,
  TranscriptMessage,
  Job,
  JobError,
  JobEvent,
  JobSpec,
  Pattern,
  PatternId,
  PatternRegistry,
  ResolveContext,
  ResolvedAssetRef,
  SystemPromptContext,
  TranscriptStore,
} from '@orchestral/core'
import { handleFindPattern, PatternSearchIndex } from '@orchestral/discovery'
import { normaliseError } from './errors'
import type { MetaSharedState } from './meta-execution-context'
import type { AgentChatMessage, AgentRunImpl } from './agent-run'

/**
 * The dispatch failures that stay THROWS out of `onToolCall` instead of
 * becoming a `SUBAGENT_TOOL_FAILED` tool result. Everything else a child
 * dispatch can fail with is handed to the model to react to — that is the
 * point of the failure shape — so this list is the exhaustive answer to "what
 * must kill the loop instead".
 *
 * Two families, and nothing else qualifies:
 *
 *   • **Cancellation.** `CANCELLED` is what `_submitJobInternal` throws when
 *     the agent's own signal aborted mid-child. An abort must end the run, not
 *     become something the model reads and retries past — a cancelled agent
 *     that keeps dispatching is a cancel that did not work. `dispatchAgent`'s
 *     own catch reads the same fact off `signal.aborted`.
 *   • **Host wiring the model cannot fix.** `ASK_USER_NOT_SUPPORTED` (a meta
 *     called `ctx.askUser` with no handler injected),
 *     `AGENT_RUN_IMPL_NOT_INJECTED` (a child agent with no loop
 *     implementation) and `AGENT_ASSET_BRIDGE_MISSING` (documented fail-loud,
 *     and already exempt from this file's own salvage path) are host-config
 *     bugs. Returning them as tool results would hide a broken host behind a
 *     model that politely tries something else.
 *
 * `AGENT_DEPTH_EXCEEDED` joins them for a third reason: it is the agent
 * recursion budget, and a budget the model can retry past is not a budget.
 * It is also the documented contrast case for the tool-call guards — refusals
 * come back as tool results, the depth cap fails the job.
 */
const CHILD_FAILURE_RETHROWN_CODES: ReadonlySet<string> = new Set([
  'CANCELLED',
  'AGENT_DEPTH_EXCEEDED',
  'ASK_USER_NOT_SUPPORTED',
  'AGENT_RUN_IMPL_NOT_INJECTED',
  'AGENT_ASSET_BRIDGE_MISSING',
])

/**
 * Render the agent allowlist's `exposureMode: 'always-load'` Patterns as direct
 * tools (inline core), and return their ids so they can be excluded from the
 * find_pattern corpus. Assembled in this package (next to
 * buildCatalogDescriptors); the host only prepends host tools. With no
 * deriveProviderOptionsZod, this falls back to the base schema (a degraded but
 * acceptable mode).
 *
 * The surface is `'agentLoop'`: this catalog is the subagent's, so an
 * `exposure: 'agent-tool'` Pattern belongs here and a chat-turn-only one does
 * not. Same gate find_pattern applies for `audience: 'agent-loop'`, so the two
 * halves of the subagent's catalog agree on who is visible.
 *
 * Throws `AGENT_TOOL_PATTERN_NOT_REGISTERED` when the allowlist names an id
 * the registry does not have. `ownerPatternId` is the agent whose
 * `loop.toolPatternIds` this is, so the error can say whose declaration went
 * unsatisfied.
 */
export function buildAgentInlineCore(
  whitelist: readonly PatternId[],
  registry: { get(id: PatternId): Pattern | undefined },
  ownerPatternId: PatternId,
): { descriptors: AgentToolDescriptor[]; inlineIds: Set<PatternId> } {
  const patterns: Pattern[] = []
  const missing: PatternId[] = []
  for (const id of whitelist) {
    // Blocklist first, and on the id alone. `onToolCall` refuses a blocklisted
    // id whether or not the author listed it, so rendering one here would
    // advertise a tool whose every call comes back SUBAGENT_BLOCKED — the
    // catalog and the call side have to say the same sentence, which is what
    // computeStaticAgentExcludes already gives the find_pattern half. Listing
    // one is an authoring no-op, not a failure: the blocklist is the one rule,
    // and naming an id past it has never widened anything. Judging before the
    // lookup also keeps the missing-id error below honest — telling a host to
    // register an `agent_` id would be advice that cannot help, since the call
    // would be refused with it registered.
    if (matchSubagentBlocklist(id)) continue
    const p = registry.get(id)
    if (p) patterns.push(p)
    else missing.push(id)
  }
  // Skipping an absent id used to be silent, which made the catalog shrink
  // under an unchanged system prompt: the agent keeps being told to use tools
  // it no longer has, and finds out one wasted turn at a time. That is the
  // quiet adjacent answer, and the allowlist is exactly the place a refusal
  // is cheap — nothing has been dispatched yet.
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `AGENT_TOOL_PATTERN_NOT_REGISTERED: ${ownerPatternId} declared ` +
          `loop.toolPatternIds containing ids absent from the registry: ` +
          `[${missing.join(', ')}]. Register those Patterns, or narrow ` +
          `loop.toolPatternIds — the agent's system prompt is written against ` +
          `the full list.`,
      ),
      { code: 'AGENT_TOOL_PATTERN_NOT_REGISTERED' },
    )
  }
  const descriptors = buildAlwaysLoadDescriptors(patterns, { surface: 'agentLoop' })
  const inlineIds = new Set<PatternId>(descriptors.map((d) => d.name as PatternId))
  return { descriptors, inlineIds }
}
/**
 * Host seam for AgentPattern asset flow. The runtime owns no asset store —
 * the canonical one lives on the host side — so the host injects this bridge
 * to let dispatchAgent resolve / record / announce against a **per-agent
 * context** (keyed by the agent's runId). A host that also runs non-agent
 * dispatch (a chat turn, say) typically implements these methods over the same
 * ledger it uses for that context.
 *
 * ### When not injected
 *
 * The bridge is optional and the whole surface is inert without it — no
 * throw, no warning. A host that skips it accepts, knowingly:
 *
 *   • **No seed announcement.** The agent's LLM never sees an
 *     `<available-assets>` block for assets passed in or inherited from a
 *     parent context (`buildSeedAnnouncement`).
 *   • **No inner asset resolution.** `input.references` handles inside the
 *     agent loop are not resolved to real assetIds; sub-dispatches run with
 *     whatever the LLM literally wrote (`resolveForDispatch`).
 *   • **No handle stamping on produced assets.** Tool outputs reach the model
 *     history as the raw adapter shape, without store-minted handles — which
 *     the downstream model-facing projection drops — so the LLM cannot refer
 *     back to what it just produced (`recordOutput`).
 *   • **No provenance / lineage.** Generated assets record no parent edges and
 *     no surfaced `from` lineage (`recordOutput`).
 *   • **No finish-tool deliverable resolution.** Handles named in the finish
 *     tool are not validated or resolved (`resolveHandles`).
 *   • **No partial-result salvage.** A failed run reports no produced-so-far
 *     assetIds (`recordedAssetIds`), and a failed child dispatch tells the loop
 *     only how many assets survived, never their handles (`handlesFor`).
 *
 * Substrate-only tests and hosts whose agents never touch assets can leave it
 * out; anything that expects an agent to hand assets between its own tool
 * calls must wire it.
 *
 * @alpha
 */
export interface AgentAssetBridge {
  /**
   * Records `passedIn` (and, when `inheritFromContextId` is set, every asset
   * visible in that parent context) into the child context — re-minting
   * child-local handles — and returns the rendered write-once announcement
   * (XML) for the agent seed, or null when there is nothing to announce.
   *
   * `sessionId` is the owner of the rows this write mints (the agent's
   * contextId is its runId, not a session id). When absent the method is a
   * no-op — a host-only agent with no session has nothing to own the rows, so
   * recording them would leak.
   */
  buildSeedAnnouncement(args: {
    contextId: string
    sessionId?: string
    passedIn: readonly ResolvedAssetRef[]
    inheritFromContextId?: string
  }): string | null
  /**
   * Resolves the subagent's `input.references` handles against its context's
   * ledger. Throws `AssetResolutionError` (fail-closed) — dispatchAgent maps it
   * to an `ASSET_RESOLUTION_FAILED` tool-result so the loop self-corrects.
   */
  resolveForDispatch(args: {
    contextId: string
    input: unknown
    assetNeeds: readonly AssetNeed[]
  }): readonly ResolvedAssetRef[]
  /**
   * Records a child dispatch's produced `output.assets[]` into the context AND
   * returns the model-facing output with the store-minted handle stamped onto
   * each produced asset (plus `origin: 'generated'` and a `from` lineage built
   * from `resolvedInputs`). dispatchAgent runs THIS return value through
   * `projectToolOutputForModel` + `sanitizeToolOutput` before handing it to
   * the loop — never the raw adapter output, whose elements carry assetId/url
   * but no handle and are therefore dropped entirely by that projection (a
   * loop without a bridge sees `assets: []`, never a real assetId).
   *
   * `patternId` names the operation on the provenance edges the host records;
   * `resolvedInputs` are the slot-keyed input assets this dispatch consumed
   * (the agent path's resolveForDispatch output), used for both that provenance
   * and the surfaced `from` lineage. Implementations typically do this as a
   * stamp-handles + record-provenance + attach-lineage sequence.
   *
   * `sessionId` is the owner of the rows this write mints (the agent's
   * contextId is its runId, not a session id). Returns `output` unchanged when
   * there is no store / no session (host-only agents with no session can't
   * record session assets) so the caller degrades rather than failing.
   */
  recordOutput(args: {
    contextId: string
    sessionId?: string
    toolCallId: string
    patternId: PatternId
    resolvedInputs: readonly ResolvedAssetRef[]
    output: unknown
  }): unknown
  /**
   * Resolves a flat list of deliverable handles against a context's ledger.
   * Fail-closed: any unknown handle throws AssetResolutionError (caller maps
   * it to a structured tool-result so the loop self-corrects). Distinct from
   * resolveForDispatch (slot-keyed references); this is the finish-tool path.
   */
  resolveHandles(args: {
    contextId: string
    handles: readonly string[]
  }): readonly ResolvedAssetRef[]
  /** assetIds recorded in a context so far — used to surface partial results
   *  when a run fails. */
  recordedAssetIds(contextId: string): readonly string[]

  /**
   * The handles this context can name for `assetIds` — the reverse direction
   * of `resolveHandles`, and the only way an assetId the host holds becomes
   * something a loop may be told about. Optional: a host whose ledger cannot
   * answer leaves it out, and a failed dispatch reports how many assets exist
   * instead of what they are called.
   *
   * Returns only the ids this context names, in any order. An id with no
   * handle here is absent from the result, never a placeholder — a fabricated
   * handle is one the loop would hand to a dispatch that then fails
   * resolution, which is worse than being told a count.
   */
  handlesFor?(args: {
    contextId: string
    assetIds: readonly string[]
  }): readonly string[]
}

/**
 * Count only the `kind==='agent'` ancestors in `visited`. Extracted as a pure
 * function for unit testing.
 */
export function countAgentAncestors(
  visited: ReadonlySet<PatternId>,
  registry: { get(id: PatternId): Pattern | undefined },
): number {
  let n = 0
  for (const id of visited) {
    if (registry.get(id)?.kind === 'agent') n++
  }
  return n
}

/**
 * Best-effort mapping from a stored TranscriptMessage back into an
 * AgentChatMessage suitable for re-seeding an agent loop on resume.
 *
 * Known limitation — resume via this function is **best-effort**, not
 * byte-exact. TranscriptMessage stores the host's agent-loop step projection
 * (text + toolCalls + usage), NOT raw provider messages. Consequences:
 *   • `tool_use_id` pairing is lost — tool-result entries can't be matched
 *     back to their originating tool_use blocks
 *   • Anthropic Extended Thinking reasoning blocks are dropped entirely
 *   • The resumed LLM sees prior text + tool outputs as separate turns
 *     rather than the original interleaved (assistant: text+tool_use →
 *     user: tool_result) structure
 *
 * A future byte-exact reasoning round-trip replaces this projection with
 * raw provider message capture; this function will then return a faithful
 * replay rather than the current downgraded form. Until then, treat resume
 * as "agent picks up the gist of where it left off" — not "agent continues
 * the exact prior conversation".
 *
 * Returns `null` for kinds the runtime should not replay back to the LLM
 * (progress / compact-boundary), letting the caller filter them out.
 */
function transcriptMessageToChat(
  m: TranscriptMessage,
): AgentChatMessage | null {
  if (m.kind === 'progress' || m.kind === 'compact-boundary') return null
  if (m.kind === 'assistant') {
    // raw is AgentLoopStep-shaped today: `{stepIndex, toolCalls, text, usage}`.
    // Extract the text portion as the assistant's contribution; tool calls
    // are dropped because we cannot reconstruct the tool_use_id pairing on
    // the SDK side anyway.
    const text =
      typeof (m.raw as { text?: unknown } | null | undefined)?.text === 'string'
        ? (m.raw as { text: string }).text
        : ''
    return { role: 'assistant', content: text }
  }
  // 'tool-result' — raw is the tool execution output we surfaced to the
  // LLM. Pass through as `tool` role; AgentRunImpl casts to its SDK shape.
  return { role: 'tool', content: m.raw }
}

/**
 * What agent dispatch borrows from the runtime. Mirrors `MetaCtxDeps`: the
 * recursion entry point is a callback rather than a back-reference, so the
 * dependency runs one way and this module never imports InlineRuntime.
 */
export interface AgentDispatchDeps {
  registry: PatternRegistry
  router: CapabilityRouter
  maxAgentDepth: number
  agentRunImpl?: AgentRunImpl
  transcriptStore?: TranscriptStore
  agentAssetBridge?: AgentAssetBridge
  catalogOptions?: BuildCatalogDescriptorsOptions
  resolveCtxProvider?: (spec: JobSpec) => ResolveContext
  /**
   * The runtime's diagnostics seam (`InlineRuntimeInit.logger`). Agent
   * dispatch reports what belongs to the job on the job stream; what reaches
   * this is what has no event and must not block the loop — a transcript
   * append that failed off the loop's critical path, and a meta's
   * `plannedDispatches` declaration that threw (treated as undeclared, so
   * there is no refusal to fan out and nothing the model should be told).
   */
  logger: DiagnosticsLogger
  /**
   * Record the envelope `getAgentEnvelope` reads. The runtime owns the table
   * and its bound; this module only reports what a dispatch produced.
   */
  recordEnvelope: (jobId: string, envelope: AgentDispatchEnvelope) => void
  fanoutJobEvent: (jobId: string, build: (job: Job) => JobEvent) => Promise<void>
  /** `InlineRuntime._submitJobInternal` — how a tool call becomes a child job. */
  submitChild: <TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
    ancestors: readonly PatternId[],
    metaSharedState?: MetaSharedState,
    parentSignal?: AbortSignal,
    parentCtx?: DispatchContext,
  ) => Promise<Job<TIn, TOut>>
}

/**
 * AgentPattern dispatch. Hands the loop over to the host-injected
 * AgentRunImpl (typical: ai-sdk ToolLoopAgent over IPC to a worker), with a
 * self-filtered tool catalog + seed messages + a reverse `onToolCall` hook
 * that recurses into `submitJob` for tool dispatch (atomic / meta / agent —
 * uniform).
 *
 * Asset handling: the agent runs in its own per-context ledger keyed by runId
 * (`agentContextId`). Sub-tool dispatches resolve their `input.references`
 * against THAT ledger via the host `AgentAssetBridge` (store ⋈ this loop's
 * transcript) — not from currentMessages (the projected message history
 * carries no assetId). The agent's own `loop.system` receives a
 * `SystemPromptContext` (DispatchContext minus `assets`): system is a cached
 * byte-stable prefix, so resolved assets reach the loop via the cache-cold
 * seed announcement, never the prefix.
 */
export async function dispatchAgent<TIn, TOut>(
deps: AgentDispatchDeps,
  jobId: string,
  pattern: AgentPattern<TIn, TOut>,
  spec: JobSpec<TIn>,
  signal: AbortSignal,
  visited: Set<PatternId>,
): Promise<TOut> {
  // Capture the envelope for `getAgentEnvelope(jobId)` lookup.
  const envelopeStartTs = Date.now()
  let envelopeToolCount = 0
  // DESIGN: agent-run-impl-not-injected
  if (!deps.agentRunImpl) {
    throw Object.assign(
      new Error(
        `AGENT_RUN_IMPL_NOT_INJECTED: ${pattern.id} — registered AgentPattern but no InlineRuntimeInit.agentRunImpl`,
      ),
      { code: 'AGENT_RUN_IMPL_NOT_INJECTED' },
    )
  }

  // Count only agent ancestors (meta/atomic don't count against the agent
  // recursion budget).
  const agentDepth = countAgentAncestors(visited, deps.registry)
  if (agentDepth > deps.maxAgentDepth) {
    throw Object.assign(
      new Error(
        `AGENT_DEPTH_EXCEEDED: ${pattern.id} (agentDepth=${agentDepth}, max=${deps.maxAgentDepth}). ` +
          `ancestor chain: ${[...visited].join(' → ')}`,
      ),
      { code: 'AGENT_DEPTH_EXCEEDED' },
    )
  }

  // System prompt (static or computed from input + ctx). System is a cached
  // byte-stable prefix, so `loop.system` gets a SystemPromptContext
  // (DispatchContext minus `assets`): resolved assets reach the loop via the
  // cache-cold seed announcement below, never the prefix.
  const systemCtx: SystemPromptContext = {
    signal,
    ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
  }
  const system =
    typeof pattern.loop.system === 'function'
      ? pattern.loop.system(spec.input, systemCtx)
      : pattern.loop.system

  const resolveCtx = deps.resolveCtxProvider?.(spec) ?? {}

  // catalog excludeIds is a STATIC list (self + default subagent blocklist
  // matches). The dynamic ancestor chain is
  // NOT included in excludeIds; ancestor cycles get caught at runtime in
  // the onToolCall closure below. Keeping excludeIds static keeps the
  // tool descriptor bytes stable across LLM turns within the agent loop
  // → Anthropic / OpenAI prompt cache hits.
  //
  // Self-exclude defends against trivial A → A recursion (same Pattern as
  // both ancestor and tool). DEFAULT_SUBAGENT_BLOCKLIST expands `agent_*`
  // prefix into concrete ids so the "a subagent doesn't see
  // grand-subagents" invariant holds structurally, without depending on a
  // prompt-assembly layer to prune. It is not overridable per Pattern:
  // `loop.toolPatternIds` narrows a catalog, it never widens one past the
  // blocklist, because `onToolCall` refuses a blocklisted id whether or not
  // the author listed it.
  //
  // Async dispatch tightens the catalog further — it exposes only
  // `toolPatternIds ∩ asyncToolPatternIds`. In sync mode asyncToolPatternIds
  // is ignored and the catalog uses the full toolPatternIds set
  // (pattern.defaultExecutionMode is the fallback that decides isAsync).
  const isAsync = pattern.defaultExecutionMode === 'async'
  const asyncAllowlist = pattern.loop.asyncToolPatternIds
  // Defence-in-depth: asyncToolPatternIds should be a subset of
  // toolPatternIds — ids outside the subset would be silently ignored in the
  // intersection, making an author's typo hard to spot. Validating at
  // registration time would be ideal, but the runtime adds a backstop here.
  if (asyncAllowlist && asyncAllowlist.length > 0) {
    const orphans = asyncAllowlist.filter(
      (id) => !pattern.loop.toolPatternIds.includes(id),
    )
    if (orphans.length > 0) {
      throw Object.assign(
        new Error(
          `ASYNC_TOOL_PATTERN_ID_NOT_IN_TOOL_LIST: ${pattern.id} declared ` +
            `loop.asyncToolPatternIds containing ids not in loop.toolPatternIds: ` +
            `[${orphans.join(', ')}]. asyncToolPatternIds must be a subset of ` +
            `toolPatternIds (likely a typo or stale reference).`,
        ),
        { code: 'ASYNC_TOOL_PATTERN_ID_NOT_IN_TOOL_LIST' },
      )
    }
  }
  const effectiveToolPatternIds: readonly PatternId[] =
    isAsync && asyncAllowlist && asyncAllowlist.length > 0
      ? pattern.loop.toolPatternIds.filter((id) =>
          asyncAllowlist.includes(id),
        )
      : pattern.loop.toolPatternIds

  const staticExcludeIds = computeStaticAgentExcludes(deps.registry, pattern.id)

  // Host tools are not assembled here. The runtime emits only the catalog
  // routing tools and forwards pattern.id to the AgentRunImpl seam; the host
  // decides which of its own tools that agent may see. Host-tool
  // visibility/policy is therefore not expressible in the Pattern spec (no
  // blocklist field, no passthrough list).
  // Inline core: the allowlist's always-load Patterns are laid out directly,
  // bypassing find_pattern.
  const { descriptors: inlineCore, inlineIds } = buildAgentInlineCore(
    effectiveToolPatternIds,
    deps.registry,
    pattern.id,
  )
  // Finish tool injection. An outputExtractor Pattern produces its output
  // from the final text, so it gets no finish tool; everything else exposes
  // the schema-visible finish descriptor. The `?? DEFAULT_AGENT_FINISH_SPEC`
  // is defensive — registration backfills pattern.finish for any agent
  // without an extractor, so it is always present in practice.
  const finishSpec = pattern.loop.outputExtractor
    ? undefined
    : (pattern.finish ?? DEFAULT_AGENT_FINISH_SPEC)
  const tools: AgentToolDescriptor[] = [
    ...inlineCore,
    ...buildCatalogDescriptors(deps.catalogOptions),
    ...(finishSpec ? [buildFinishDescriptor(finishSpec.inputs)] : []),
  ]

  // find_pattern search corpus. Scoped to effectiveToolPatternIds
  // ∖ staticExcludeIds so the subagent's catalog stays inside its declared
  // loop.toolPatternIds whitelist. Built per-dispatch (cheap — minisearch
  // indexes ~20 patterns in <1ms; registry doesn't mutate during loop).
  const subagentSearchIndex = new PatternSearchIndex(deps.registry)
  // find_pattern corpus = allowlist ∖ already-inlined (those are directly
  // visible, no need to search for them).
  const findPatternIncludeOnly = new Set(
    [...effectiveToolPatternIds].filter((id) => !inlineIds.has(id)),
  )
  const findPatternExcludeIds = new Set([...staticExcludeIds, ...visited])

  // Seed messages — subagent runs fresh, parent chat history NOT inherited.
  //
  //   • seed = single user message whose content is `input.prompt` ONLY
  //     (parent LLM writes a natural-language brief via the framework-provided
  //     base schema; see @orchestral/core `agentInputSchema`).
  //   • host-injected context (ctx.assets / providerOptions / any host-owned
  //     scoping ids) does NOT enter the seed — host-only fields never reach
  //     LLM context.
  //   • Pattern-specific extras (input.X beyond `prompt`/`description`) are
  //     surfaced by the Pattern author's own `loop.system` template — the
  //     framework does NOT auto-render or JSON.stringify them into the seed.
  //   • `description` flows to transcript title / log meta (writeAgentMetadata),
  //     not the seed.
  const seedPromptValue = (spec.input as { prompt?: unknown } | null | undefined)?.prompt
  if (typeof seedPromptValue !== 'string' || seedPromptValue.length === 0) {
    throw Object.assign(
      new Error(
        `AGENT_SEED_PROMPT_MISSING: ${pattern.id} — AgentPattern's tool.inputs ` +
          `must include a non-empty string field 'prompt' (see @orchestral/core ` +
          `agentInputSchema). The parent LLM fills it during tool-call; runtime ` +
          `uses it as the subagent's single seed user message.`,
      ),
      { code: 'AGENT_SEED_PROMPT_MISSING' },
    )
  }

  // Transcript runId / agentId derivation.
  //
  //   • runId  = spec.resumeFromRunId ?? jobId
  //     New dispatch: runId = this submitJob's own jobId (runId = the JobId of
  //     the parent submitJob). Resume: runId switches to the previous submit's
  //     jobId so writes land in the SAME (run_id, agent_id) bucket the
  //     original dispatch wrote to. Reclaiming those rows is the host's job:
  //     when it deletes a job it calls `TranscriptStore.clear(runId)`, which
  //     drops every agentId bucket under that runId. Without that hook the
  //     store just accumulates — the runtime never deletes transcripts.
  //   • agentId = `${pattern.id}#${runId}`
  //     Deterministic — a single submitJob dispatches at most one
  //     AgentPattern (sub-agents reached via onToolCall use independent
  //     _submitJobInternal → independent jobId → independent runId), so
  //     within a runId there's exactly one logical agent. No randomUUID
  //     is needed; the pattern.id prefix preserves the "agent type"
  //     signal in queries / logs.
  //   • sessionId is intentionally NOT consulted here. It stays a pure
  //     chat-session label (idempotency hash bucket, JobStore filter,
  //     host-side per-session model preferences) and never participates in transcript
  //     addressing. The "one agent per runId" structural invariant means we
  //     don't need an explicit agentId override on resume — the same effect
  //     falls out of the
  //     deterministic derivation, no override knob required.
  const store = deps.transcriptStore
  const runId = spec.resumeFromRunId ?? jobId
  const agentId = `${pattern.id}#${runId}`

  // Agent context = runId (per-agent handle namespace). The host
  // AgentAssetBridge records `passedIn` assets into this context (re-minting
  // child-local handles) and renders a write-once seed announcement. Opt-in
  // `inheritParentAssets` pulls from the dispatching chat/session context
  // (`spec.sessionId`); deeper nested-agent inherit is out of scope.
  const agentContextId = runId
  const seedAnnouncement =
    deps.agentAssetBridge?.buildSeedAnnouncement({
      contextId: agentContextId,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      passedIn: spec.assets ?? [],
      ...(pattern.loop.inheritParentAssets && spec.sessionId
        ? { inheritFromContextId: spec.sessionId }
        : {}),
    }) ?? null

  // Resume from a prior transcript when the caller opts in. Read the prior
  // (runId, agentId) bucket as a single sequence and reconstruct the LLM seed
  // messages from it. Reconstruction is approximate — we lose tool_use_id
  // pairing + reasoning blocks since the transcript captures the host's
  // agent-loop step projection, not raw provider messages. A future reasoning
  // round-trip closes that gap; see transcriptMessageToChat JSDoc.
  //
  // The prior transcript is read as a single bucket; new messages append to
  // the same bucket with seq continuing from max+1 so the full agent history
  // stays in one ordered sequence across any number of resumes.
  const priorMessages: AgentChatMessage[] = []
  let transcriptSeq = 0
  if (spec.resumeFromRunId) {
    if (!store) {
      throw Object.assign(
        new Error(
          `RESUME_REQUIRES_TRANSCRIPT_STORE: spec.resumeFromRunId is set but ` +
            `InlineRuntime was constructed without a transcriptStore. Inject ` +
            `one (a durable store in production, InMemoryTranscriptStore for ` +
            `tests) before resume.`,
        ),
        { code: 'RESUME_REQUIRES_TRANSCRIPT_STORE' },
      )
    }
    const prior = await store.read(runId, agentId)
    // Refuse to resume when the target (runId, agentId) bucket is empty rather
    // than silently downgrade to a fresh dispatch. Stale jobIds, a mistaken
    // sessionId-vs-jobId mix-up,
    // or transcripts cleared out-of-band all surface as a hard error so
    // callers know they're not actually continuing prior work.
    if (prior.length === 0) {
      throw Object.assign(
        new Error(
          `RESUME_TARGET_NOT_FOUND: ${pattern.id} — no transcript rows under ` +
            `(runId=${spec.resumeFromRunId}, agentId=${agentId}). Either the ` +
            `previous dispatch never wrote to the transcriptStore (no agent ` +
            `loop steps completed) or resumeFromRunId points to a different ` +
            `Pattern's jobId.`,
        ),
        { code: 'RESUME_TARGET_NOT_FOUND' },
      )
    }
    for (const m of prior) {
      const reconstructed = transcriptMessageToChat(m)
      if (reconstructed) priorMessages.push(reconstructed)
    }
    transcriptSeq = prior[prior.length - 1].seq + 1
  }

  // The seed announcement (when non-null) is a standalone user message placed
  // BEFORE the prompt (write-once; the prompt text itself is
  // never modified). Cache-cold by design — it carries the resolved assets
  // that the cached system prefix deliberately omits.
  const seedMessages: AgentChatMessage[] = [
    ...priorMessages,
    ...(seedAnnouncement
      ? [{ role: 'user' as const, content: seedAnnouncement }]
      : []),
    { role: 'user', content: seedPromptValue },
  ]

  // Abort-mode control.
  //
  // 'inherit' (default): the parent's abort propagates to the child. The
  //   child's AbortController subscribes to the parent's parentSignal inside
  //   _submitJobInternal.
  // 'independent': the child gets an independent lifecycle. _submitJobInternal
  //   detects Pattern kind === agent + abortMode === 'independent' → skips the
  //   parentSignal subscription, so the child's controller can only be
  //   triggered by `runtime.cancelJob(childJobId)`. If the host process
  //   driving the parent loop exits or crashes the child keeps running, and
  //   a later run re-attaches to its transcript via
  //   `JobSpec.resumeFromRunId`.
  //
  // The decision is made on the _submitJobInternal side via the
  // isIndependentAgent branch; dispatchAgent here just forwards the signal —
  // upstream has already bound the controller to cancelJob. The sub-dispatch
  // inside this agent's onToolCall does NOT explicitly forward the `signal`
  // field (see the onToolCall implementation below); it relies on
  // _submitJobInternal minting a fresh controller per child dispatch, so the
  // parent's cancelJob does NOT cascade through a signal closure into the
  // grandchild layer — which is exactly the behaviour 'independent' wants.
  //
  // Two stop mechanisms apply and both work: a natural stop condition owned
  // by the host (the runtime declares no stopWhen; the host AgentRunImpl
  // resolves it per patternId), plus cancelJob for active host intervention.
  // A wall-clock limit (loop.maxWallClockMs) is left as a follow-up.
  const childSignal = signal

  // Transcript persistence: when a transcriptStore is injected, append one
  // message-boundary event from each AgentLoopStep completion callback. SSE
  // deltas are NOT recorded (only recordable message boundaries). Without a
  // store, dispatchAgent writes nothing and behaviour degrades to ephemeral.
  //
  // A callback (`onStepFinish`) is used instead of an AsyncGenerator so the
  // host AgentRunImpl doesn't have to be generator-driven — it just adds a
  // hook at step-end.
  const recordStep = store
    ? (step: { stepIndex: number; toolCalls: readonly { name: string; input?: unknown }[]; text: string; usage?: { totalTokens?: number } }) => {
        // record the assistant message boundary (text + toolCalls + usage)
        const msg: TranscriptMessage = {
          seq: transcriptSeq++,
          ts: Date.now(),
          kind: 'assistant',
          raw: step,
        }
        void store
          .append(runId, agentId, msg)
          .catch((err: unknown) => {
            // An append failure must not block the agent loop; report it on
            // the host's diagnostics channel and let the host decide whether
            // to escalate it to fatal.
            deps.logger.warn(
              `[dispatchAgent] transcriptStore.append failed for ${runId}/${agentId} seq=${msg.seq}:`,
              err,
            )
          })
      }
    : undefined

  // Finish-broker closure state. `finishState.value` holds the last VALID
  // finish payload + its resolved deliverables (last-write-wins); `stepCounter`
  // tallies loop steps for the AgentRunFacts handed to compose. A ref cell
  // (not a bare `let`) so the value survives TS's closure-capture narrowing:
  // a `let` conditionally assigned inside onToolCall narrows back to `null`
  // at the finalize/catch reads, collapsing the truthy branch to `never`. A
  // property on a const object narrows correctly after the run() call.
  const finishState: {
    value:
      | { payload: unknown; resolved: readonly (ResolvedAssetRef & { label?: string })[] }
      | null
  } = { value: null }
  let stepCounter = 0

  // Output schema hoisted to function scope so the salvage catch below can
  // parse against it. Registration backfills a schema for every agent; a
  // missing one is a corrupted-registry invariant, not a runtime condition.
  const outputsSchema = pattern.outputs
  if (!outputsSchema) {
    throw Object.assign(
      new Error(
        `AGENT_OUTPUTS_MISSING: ${pattern.id} — registered AgentPattern lost its outputs schema`,
      ),
      { code: 'AGENT_OUTPUTS_MISSING' },
    )
  }

  // Step visibility — every step-end with in-flight tool calls fans out a
  // job:progress whose message names them, so the host's task strip can show
  // WHAT a long-running agent is doing (an LLM loop emits no provider-level
  // progress, leaving the row a bare spinner). Composes with the optional
  // transcript recorder above; fraction 0 = indeterminate.
  const onStep = (step: {
    stepIndex: number
    toolCalls: readonly { name: string; input?: unknown }[]
    text: string
    usage?: { totalTokens?: number }
  }): void => {
    stepCounter += 1
    recordStep?.(step)
    if (step.toolCalls.length > 0) {
      void deps.fanoutJobEvent(jobId, (job) => ({
        type: 'job:progress',
        job,
        fraction: 0,
        message: `step ${step.stepIndex + 1} · ${step.toolCalls.map((c) => c.name).join(', ')}`,
      }))
    }
  }

  // Partial results — if the whole agent run (LLM loop OR output sanitize)
  // throws, attach the assetIds produced so far to the error so the parent's
  // tool-result envelope can surface them downstream.
  try {
    const result = await deps.agentRunImpl.run({
      system,
      patternId: pattern.id,
      runContextId: agentContextId,
      messages: seedMessages,
      tools,
      modelTags: pattern.loop.modelTags,
      resolveCtx,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      abortSignal: childSignal,
      finishToolName: AGENT_FINISH_TOOL_NAME,
      onStepFinish: onStep,
      onToolCall: async ({ name, input, callId }) => {
        // ── finish tool — task-completion signal ───────────────────────
        // Intercepted BEFORE inline-core normalisation so the finish name
        // never routes into dispatch_pattern. Validates the payload, resolves
        // any deliverable handles against this agent's ledger, and records
        // the last valid finish (last-write-wins). Two self-healing errors
        // (INVALID_FINISH / UNRESOLVED_DELIVERABLE) come back as tool-results
        // so the loop retries; a missing bridge is a host-config bug and
        // throws (fail-loud at the run level).
        if (finishSpec && name === AGENT_FINISH_TOOL_NAME) {
          const parsed = finishSpec.inputs.safeParse(input)
          if (!parsed.success) {
            return {
              error: 'INVALID_FINISH',
              issues: parsed.error.issues,
              ...(finishState.value
                ? { note: 'Your previous valid finish remains in effect.' }
                : {}),
            }
          }
          const handles =
            ((parsed.data as { deliverables?: { handle: string; label?: string }[] })
              .deliverables ?? [])
          let resolved: readonly (ResolvedAssetRef & { label?: string })[] = []
          if (handles.length > 0) {
            if (!deps.agentAssetBridge) {
              throw Object.assign(
                new Error(
                  `AGENT_ASSET_BRIDGE_MISSING: ${pattern.id} finish carries ` +
                    `deliverable handles but no AgentAssetBridge is injected.`,
                ),
                { code: 'AGENT_ASSET_BRIDGE_MISSING' },
              )
            }
            try {
              const refs = deps.agentAssetBridge.resolveHandles({
                contextId: agentContextId,
                handles: handles.map((h) => h.handle),
              })
              resolved = refs.map((r, i) => ({
                ...r,
                ...(handles[i]?.label !== undefined ? { label: handles[i].label } : {}),
              }))
            } catch (e) {
              // The production bridge throws `.message='ASSET_RESOLUTION_FAILED'`
              // with the actionable detail ({code, handle, meta}) on `.error`
              // (mirrors the dispatch-side resolveForDispatch catch below). Surface
              // that structured detail so the model can see WHICH handle failed and
              // WHY, not just an opaque code string.
              const detail =
                e instanceof Error && 'error' in e && (e as { error?: unknown }).error !== undefined
                  ? (e as { error?: unknown }).error
                  : undefined
              return {
                error: 'UNRESOLVED_DELIVERABLE',
                message: e instanceof Error ? e.message : String(e),
                ...(detail !== undefined ? { detail } : {}),
                hint: 'Use handles exactly as they appear in the available-assets list / tool results, then call the finish tool again.',
              }
            }
          }
          finishState.value = { payload: parsed.data, resolved }
          return { acknowledged: true }
        }

        // Three top-level tool name families:
        //   • host tools       → host tool registry (e.g. list_assets,
        //                        prefix-less)
        //   • find_pattern     → catalog discovery (returns Pattern descriptors)
        //   • dispatch_pattern → Pattern invocation (routes to _submitJobInternal)
        // Per-Pattern tool names no longer exist; the LLM always goes through
        // find_pattern → dispatch_pattern (or knows pattern_id from prior turn).

        // Host tools do NOT pass through this onToolCall — AgentRunImpl must
        // intercept them (rule 2 in agent-run.ts "Implementing
        // AgentRunImpl"). This hook only handles find_pattern /
        // dispatch_pattern; a host tool name arriving here means the
        // implementation didn't intercept it, and it falls through to
        // UNKNOWN_TOOL below.

        // Inline-core routing: when the tool name is a pattern id from the
        // inline core, it is equivalent to dispatch_pattern({pattern_id: name,
        // input}). After normalisation it lands in the shared dispatch_pattern
        // branch below, reusing its full resolve/cycle/allowlist/asset handling
        // (mirrors the chat-turn alwaysLoadIds → executeDispatch routing).
        let routeName = name
        let routeInput: unknown = input
        if (inlineIds.has(name as PatternId)) {
          routeName = 'dispatch_pattern'
          routeInput = { pattern_id: name, input }
        }

        // ── find_pattern — catalog discovery ───────────────────────────
        if (routeName === 'find_pattern') {
          const parsed = FindPatternInputSchema.safeParse(input)
          if (!parsed.success) {
            // Surface the validation error as the tool's return value so the
            // LLM can read the zod issues and retry with a corrected query.
            return {
              error: 'INVALID_INPUT',
              tool: 'find_pattern',
              issues: parsed.error.issues,
            }
          }
          return handleFindPattern(subagentSearchIndex, parsed.data, {
            router: deps.router,
            resolveCtx,
            includeOnly: findPatternIncludeOnly,
            excludeIds: findPatternExcludeIds,
            // Inline-core patterns are excluded from the search corpus
            // above — when a zero-match query was
            // actually aiming at one of them, the diagnostic must point at
            // the direct tool instead of suggesting synonym roulette.
            directToolIds: inlineIds,
            // Subagent audience — surfaces exposure='agent-tool'
            // Patterns (fine-grained primitives meant only for agent loops).
            // chat-turn audience (default) would hide them — wrong here.
            audience: 'agent-loop',
          })
        }

        // ── dispatch_pattern — Pattern invocation ──────────────────────
        if (routeName === 'dispatch_pattern') {
          const parsed = DispatchPatternInputSchema.safeParse(routeInput)
          if (!parsed.success) {
            return {
              error: 'INVALID_INPUT',
              tool: 'dispatch_pattern',
              issues: parsed.error.issues,
            }
          }
          // Subagent loop runs on agent-loop audience; resolveDispatchTarget
          // enforces exposure scope symmetrically (rejects 'no-tool' patterns,
          // permits 'agent-tool').
          const target = resolveDispatchTarget(deps.registry, parsed.data, 'agent-loop')
          if (isDispatchError(target)) {
            // Pattern lookup or input zod validation failed — return as
            // tool_result content so LLM self-corrects on next turn.
            return target
          }
          const fullId = target.pattern.id
          // Runtime ancestor check. A two-stage catalog has no per-Pattern
          // descriptors to strip up-front, so the cycle check fires here on
          // the resolved pattern_id.
          //
          // This is the ONLY defence against a ring that closes through
          // non-agent patterns, so do not delete it as redundant with the
          // other two guards:
          //   • `maxAgentDepth` cannot see such a ring. `countAgentAncestors`
          //     counts only `kind === 'agent'` ancestors, so
          //     agent_A →(tool) meta_hop →(step) agent_B →(tool) meta_hop → …
          //     spins with the agent count pinned at 2 — and widening the ring
          //     with more metas never raises it.
          //   • DEFAULT_SUBAGENT_BLOCKLIST only matches `agent_`-prefixed ids,
          //     so it catches an agent re-entering an agent and nothing else.
          //     A ring whose repeated hop is a meta or an atomic walks past it.
          // The `agent_ → agent_` case is the only one with a second line of
          // defence; every other shape has this check and nothing else.
          //
          // It also supplies the only bound on non-agent chain depth: nothing
          // caps how deep meta → meta → … may nest, but `visited` forbids
          // repeating an id, so a chain cannot exceed the number of registered
          // patterns. That bound is a side effect of cycle detection rather
          // than a designed limit — finite, but not a budget anyone chose.
          if (visited.has(fullId)) {
            // Observability first: a refused call is a fact the host should be
            // able to audit (an agent reaching outside its scope, or probing
            // the same edge repeatedly), and every guard below returns early,
            // before the envelope / transcript / event bookkeeping on the
            // success path. Without this fan-out the attempt would exist only
            // inside the model's context window.
            //
            // Awaited, not fire-and-forget. `fanoutJobEvent` reads the job
            // row before emitting; a bare `void` leaves that read racing the
            // rest of the run, and against a slow JobStore it can land after
            // the terminal event — where `fanout` has already released the
            // subscriber set, so the rejection is dropped rather than merely
            // late. Awaiting costs one store read on a call that is being
            // refused anyway, and cannot turn a refused call into a failed one
            // (fanoutJobEvent swallows its own store failures).
            //
            // Deliberately NOT appended to the TranscriptStore. The only
            // replayable kind is 'tool-result' (see `transcriptMessageToChat`),
            // so recording a rejection there would inject new `role: 'tool'`
            // turns into the resume seed and change what a resumed model sees.
            // The event stream carries the audit trail instead — the same
            // choice `job:step` and `job:alternative-selected` already make.
            await deps.fanoutJobEvent(jobId, (job) => ({
              type: 'job:tool-rejected',
              job,
              patternId: fullId,
              callerPatternId: pattern.id,
              code: 'CIRCULAR_AGENT_TOOL',
              ancestors: [...visited],
            }))
            // Return structured tool_result instead of throwing so the LLM
            // can read the cycle and pick a different pattern_id mid-loop,
            // instead of having ai-sdk treat throw as a stream-fatal error.
            return {
              code: 'CIRCULAR_AGENT_TOOL',
              pattern_id: fullId,
              caller_pattern_id: pattern.id,
              ancestors: [...visited],
              message: `Cycle: ${pattern.id} → ${fullId} (ancestors: ${[...visited].join(' → ')})`,
              hint: 'Choose a different pattern_id that is not already on the dispatch chain.',
            }
          }
          // Scope enforcement. A per-Pattern catalog could enforce
          // loop.toolPatternIds by simply not emitting descriptors outside the
          // allowlist. With two-stage discovery the LLM only ever sees
          // `find_pattern` + `dispatch_pattern` — so a hallucinating /
          // adversarial LLM can construct a pattern_id referencing any Pattern
          // in the registry (cached from prior sessions, leaked via system
          // prompt, or guessed). Tightening the catalog-side filter
          // (find_pattern's includeOnly) is necessary but NOT sufficient —
          // dispatch must reject any pattern outside the declared
          // loop.toolPatternIds whitelist, regardless of whether the id also
          // matches the default blocklist prefix.
          //
          // Use effectiveToolPatternIds so the async filter is honoured here too.
          // DESIGN: subagent-tool-allowlist
          const inAllowlist = effectiveToolPatternIds.includes(fullId)
          if (!inAllowlist) {
            // Host-visible before the model-visible return — see the cycle
            // guard above for why this is awaited and why it stays out of the
            // transcript. `effectiveToolPatternIds` (not the raw
            // `loop.toolPatternIds`) is what the guard judged against, so it
            // is what the event reports.
            await deps.fanoutJobEvent(jobId, (job) => ({
              type: 'job:tool-rejected',
              job,
              patternId: fullId,
              callerPatternId: pattern.id,
              code: 'SUBAGENT_TOOL_OUT_OF_SCOPE',
              allowlist: effectiveToolPatternIds,
            }))
            return {
              code: 'SUBAGENT_TOOL_OUT_OF_SCOPE',
              pattern_id: fullId,
              caller_pattern_id: pattern.id,
              allowlist: effectiveToolPatternIds,
              message:
                `${fullId} not in this subagent's loop.toolPatternIds allowlist ` +
                `(declared: [${effectiveToolPatternIds.join(', ')}]).`,
              hint: 'Use find_pattern to discover which patterns are dispatchable here.',
            }
          }
          // Belt-and-suspenders: DEFAULT_SUBAGENT_BLOCKLIST is still checked
          // even for in-allowlist Patterns (Pattern authors opt-in to
          // allowlisted ids; the blocklist catches deeper authoring mistakes
          // like listing `agent_*` ids in loop.toolPatternIds by accident).
          const blocked = matchSubagentBlocklist(fullId)
          if (blocked) {
            // Host-visible before the model-visible return — see the cycle
            // guard above.
            await deps.fanoutJobEvent(jobId, (job) => ({
              type: 'job:tool-rejected',
              job,
              patternId: fullId,
              callerPatternId: pattern.id,
              code: 'SUBAGENT_BLOCKED',
              matched: blocked,
            }))
            return {
              code: 'SUBAGENT_BLOCKED',
              pattern_id: fullId,
              caller_pattern_id: pattern.id,
              reason: blocked,
              message:
                `${fullId} matched DEFAULT_SUBAGENT_BLOCKLIST. ` +
                `Pattern authors should NOT list blocklist-prefixed ids in loop.toolPatternIds.`,
              hint: 'Choose a different pattern_id; agent-prefixed ids cannot be recursed into.',
            }
          }
          // ── Declared inner dispatches — plannedDispatches ───────────────
          //
          // The three guards above judged the id the loop asked for. A meta
          // that DECLARES what it will dispatch is held to the same three
          // judgements for every id it names, before anything is submitted:
          // a plan's inner steps inherit the allowlist of the call that
          // dispatched the plan, rather than escaping it by being one level
          // down. `_submitJobInternal` checks only `registry.get`, and
          // `ctx.step` adds only DUPLICATE_STEP_ID / CIRCULAR_META_STEP, so
          // without this a meta in `toolPatternIds` can step into anything
          // registered.
          //
          // Undeclared metas are deliberately untouched — `plannedDispatches`
          // absent means "not knowable", which stays the status quo for any
          // meta that does not declare (the shipped catalog does; a
          // third-party one need not), and requiring it is a decision about
          // every meta rather than a property of this guard (docs/plan.md,
          // "We don't close the allowlist bypass for hand-written metas
          // here").
          //
          // The runtime names no pattern id here. The check keys on the
          // declaration alone, so an interpreted plan, a one-shot plan meta
          // and a shipped meta that opts in later all reach the same code.
          // DESIGN: planned-dispatches-guard
          if (target.pattern.kind === 'meta' && target.pattern.plannedDispatches) {
            let declared: readonly PatternId[] | undefined
            try {
              declared = target.pattern.plannedDispatches(target.parsedInput)
            } catch (e) {
              // A declaration that throws is treated as UNDECLARED — never as
              // a refusal, never as a crash. `plannedDispatches` is an
              // author's optional, pure hint evaluated on the dispatch path;
              // a guard that can itself fail a dispatch would be a new
              // failure mode for every meta that opts in, and refusing on a
              // buggy declaration would be a denial of service written by the
              // pattern author. The attempt has no job of its own to report
              // on, so it goes to the host's diagnostics seam rather than the
              // event stream (and never to the console — the runtime does not
              // own the host's log).
              deps.logger.warn(
                `[dispatchAgent] ${fullId}.plannedDispatches threw for a call from ` +
                  `${pattern.id}; treating the meta as undeclared, so its inner ` +
                  `steps are NOT pre-checked against this agent's allowlist:`,
                e,
              )
              declared = undefined
            }
            // First offender wins, in declaration order, judged in the same
            // order of severity the direct guards use for a single id. Each
            // refusal is that guard's existing shape — same fields, same
            // event, same `job:tool-rejected` fan-out — plus `via`, naming
            // the declared id that offended. `pattern_id` stays the call the
            // loop actually made, so the model can tell WHICH of its calls
            // was refused; `via` tells it why.
            for (const inner of declared ?? []) {
              if (!effectiveToolPatternIds.includes(inner)) {
                await deps.fanoutJobEvent(jobId, (job) => ({
                  type: 'job:tool-rejected',
                  job,
                  patternId: fullId,
                  callerPatternId: pattern.id,
                  via: inner,
                  code: 'SUBAGENT_TOOL_OUT_OF_SCOPE',
                  allowlist: effectiveToolPatternIds,
                }))
                return {
                  code: 'SUBAGENT_TOOL_OUT_OF_SCOPE',
                  pattern_id: fullId,
                  caller_pattern_id: pattern.id,
                  via: inner,
                  allowlist: effectiveToolPatternIds,
                  message:
                    `${fullId} declares it would dispatch ${inner}, which is not in ` +
                    `this subagent's loop.toolPatternIds allowlist ` +
                    `(declared: [${effectiveToolPatternIds.join(', ')}]).`,
                  hint: 'Use find_pattern to discover which patterns are dispatchable here.',
                }
              }
              const innerBlocked = matchSubagentBlocklist(inner)
              if (innerBlocked) {
                await deps.fanoutJobEvent(jobId, (job) => ({
                  type: 'job:tool-rejected',
                  job,
                  patternId: fullId,
                  callerPatternId: pattern.id,
                  via: inner,
                  code: 'SUBAGENT_BLOCKED',
                  matched: innerBlocked,
                }))
                return {
                  code: 'SUBAGENT_BLOCKED',
                  pattern_id: fullId,
                  caller_pattern_id: pattern.id,
                  via: inner,
                  reason: innerBlocked,
                  message:
                    `${fullId} declares it would dispatch ${inner}, which matched ` +
                    `DEFAULT_SUBAGENT_BLOCKLIST. Pattern authors should NOT list ` +
                    `blocklist-prefixed ids in loop.toolPatternIds.`,
                  hint: 'Choose a different pattern_id; agent-prefixed ids cannot be recursed into.',
                }
              }
              // `visited` is the chain that reached THIS agent; the meta
              // itself joins it only when the child is submitted, so a meta
              // declaring itself is left to the engine's own
              // CIRCULAR_META_STEP rather than pre-judged here.
              if (visited.has(inner)) {
                await deps.fanoutJobEvent(jobId, (job) => ({
                  type: 'job:tool-rejected',
                  job,
                  patternId: fullId,
                  callerPatternId: pattern.id,
                  via: inner,
                  code: 'CIRCULAR_AGENT_TOOL',
                  ancestors: [...visited],
                }))
                return {
                  code: 'CIRCULAR_AGENT_TOOL',
                  pattern_id: fullId,
                  caller_pattern_id: pattern.id,
                  via: inner,
                  ancestors: [...visited],
                  message:
                    `Cycle: ${pattern.id} → ${fullId} → ${inner} ` +
                    `(ancestors: ${[...visited].join(' → ')})`,
                  hint: 'Choose a different pattern_id that is not already on the dispatch chain.',
                }
              }
            }
          }
          // Inner resolution — resolve the child's `input.references`
          // handles against THIS agent's context ledger before dispatch.
          // resolveForDispatch is fail-closed (throws on any resolution
          // failure); a broad catch maps it to an ASSET_RESOLUTION_FAILED
          // tool-result so the loop self-corrects rather than dying.
          let childAssets: readonly ResolvedAssetRef[] = []
          if (deps.agentAssetBridge && (target.pattern.assetNeeds?.length ?? 0) > 0) {
            try {
              childAssets = deps.agentAssetBridge.resolveForDispatch({
                contextId: agentContextId,
                input: target.parsedInput,
                assetNeeds: target.pattern.assetNeeds ?? [],
              })
            } catch (e) {
              const innerError =
                (e as { error?: unknown }).error ??
                (e instanceof Error ? e.message : String(e))
              const innerCode = (e as { error?: { code?: string } }).error?.code
              return {
                code: 'ASSET_RESOLUTION_FAILED',
                pattern_id: fullId,
                error: innerError,
                hint:
                  innerCode === 'UNKNOWN_SLOT'
                    ? "Unknown references key — use only the pattern's declared slots (see error.meta.declaredSlots)."
                    : 'Reference an asset handle in your inventory, or generate the source first.',
              }
            }
          }
          // One transcript record for every model-facing tool result this
          // branch hands back — success and failure alike. The transcript is
          // replayed straight into model context on resume
          // (`transcriptMessageToChat` returns a 'tool-result' as a `tool`
          // turn verbatim), so it must hold exactly what the model saw the
          // first time, and nothing the model never saw. Skipped when no store
          // was injected; an append failure is logged but never blocks the
          // agent loop (the in-flight LLM call is more important than the log).
          const recordToolResult = (output: unknown): void => {
            if (!store) return
            const toolResultMsg: TranscriptMessage = {
              seq: transcriptSeq++,
              ts: Date.now(),
              kind: 'tool-result',
              raw: { name, output, pattern_id: fullId },
            }
            void store
              .append(runId, agentId, toolResultMsg)
              .catch((err: unknown) => {
                deps.logger.warn(
                  `[dispatchAgent] transcriptStore.append (tool-result) failed for ${runId}/${agentId} seq=${toolResultMsg.seq}:`,
                  err,
                )
              })
          }
          // The model-facing shape for a failed child dispatch, built from the
          // child's JobError however that failure arrived — a stored errored
          // row (the cached path) or a throw out of `submitChild` (every fresh
          // failure). One builder, because the two are the same event to the
          // model: the inner Pattern did not produce output, and the loop has
          // to decide what to do next.
          //
          // error_class: invalid-input (HTTP 4xx, except transient 408/429)
          // means the subagent's parameters were wrong for the resolved model —
          // schema unchanged, fix and retry. Everything else reads as
          // provider/transient trouble. Mirrors the chat-turn JOB_FAILED
          // classification; the subagent path carries no next_input_schema
          // (its find_pattern runs in degraded base-schema mode).
          const childToolFailure = (
            jobError: JobError | null | undefined,
          ): Record<string, unknown> => {
            const rawDetails = jobError?.details
            const httpStatus = (rawDetails as { httpStatus?: number } | undefined)?.httpStatus
            const errorClass =
              httpStatus != null &&
              httpStatus >= 400 &&
              httpStatus < 500 &&
              httpStatus !== 408 &&
              httpStatus !== 429
                ? 'invalid-input'
                : 'other'
            // `details` is the structured half of the failure and the reason
            // this shape exists: `planStepId` names WHICH step of a plan
            // failed, `issues` names the fields an OUTPUT_SCHEMA_MISMATCH
            // rejected, `httpStatus` / `failedModel` explain a provider
            // refusal. It passes through — minus `rawOutput`.
            //
            // `rawOutput` is the output gate's host-facing salvage: the entire
            // value that failed the schema, unbounded and unprojected. This
            // result goes straight into the loop's model context, where every
            // payload is projected and bounded (the same rule the success path
            // enforces with projectToolOutputForModel + sanitizeToolOutput), so
            // it is dropped here and stays where it belongs — on the child's
            // JobError, for the host.
            let details: Record<string, unknown> | undefined
            if (
              typeof rawDetails === 'object' &&
              rawDetails !== null &&
              !Array.isArray(rawDetails)
            ) {
              const rest: Record<string, unknown> = { ...(rawDetails as Record<string, unknown>) }
              delete rest.rawOutput
              if (Object.keys(rest).length > 0) details = sanitizeToolOutput(rest)
            }
            // Partial work from a child that failed. `producedAssets` is the
            // host-facing carrier — real assetIds — and the model's asset
            // language is handles, so the ids are translated here rather than
            // echoed. An assetId in this result would be both unusable (the
            // loop cannot reference one) and the exact leak
            // `projectToolOutputForModel` exists to prevent on the success
            // path; `rawOutput` two blocks up is dropped for the same reason.
            //
            // Only assets THIS context can name become handles. A sub-agent's
            // rows usually live in its own ledger and cannot be named from
            // here, so those are a count: "there is partial work you cannot
            // address" is honest and still actionable (the loop can dispatch
            // again rather than assume it produced nothing), while an id it can
            // neither resolve nor cite is not.
            const producedIds = jobError?.producedAssets ?? []
            let producedHandles: readonly string[] = []
            if (producedIds.length > 0 && deps.agentAssetBridge?.handlesFor) {
              try {
                producedHandles = deps.agentAssetBridge.handlesFor({
                  contextId: agentContextId,
                  assetIds: producedIds,
                })
              } catch (err) {
                // A host lookup that throws must not turn a tool-result the
                // loop can act on into a throw that kills the run.
                deps.logger.warn(
                  `[dispatchAgent] agentAssetBridge.handlesFor failed for ${fullId}:`,
                  err,
                )
              }
            }
            return {
              code: 'SUBAGENT_TOOL_FAILED',
              pattern_id: fullId,
              error_class: errorClass,
              ...(jobError?.code ? { inner_code: jobError.code } : {}),
              ...(producedHandles.length ? { produced_handles: producedHandles } : {}),
              ...(producedIds.length ? { produced_count: producedIds.length } : {}),
              message: jobError?.message ?? 'inner pattern dispatch failed',
              ...(details ? { details } : {}),
              hint:
                errorClass === 'invalid-input'
                  ? 'The provider rejected these parameters (HTTP 4xx). Fix or drop the offending fields named in message, then dispatch again.'
                  : 'Try different input, or pick a different pattern_id via find_pattern.',
            }
          }
          let child: Job
          try {
            child = await deps.submitChild({
              patternId: fullId,
              input: target.parsedInput,
              // The child's resolved assets come from THIS agent context's
              // ledger (store ⋈ this loop's transcript) via the host
              // AgentAssetBridge — NOT from currentMessages (the projected
              // message history carries no assetId).
              ...(childAssets.length > 0 ? { assets: childAssets } : {}),
              ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
              // Stamp this agent's ledger context so a meta child resolves ITS
              // sub-step references against the agent's runId ledger (where this
              // LLM's handles live), not the caller's.
              assetContextId: agentContextId,
            // Pass the agent's own controller signal (closed over from
            // dispatchAgent's `signal` param) as the child's
            // parentSignal so `cancelJob(agentJobId)` cascades into every tool
            // sub-dispatch. For `abortMode: 'independent'` agents this still
            // works: the agent itself ignores its parent's signal (gated in
            // _submitJobInternal), but its own signal still binds its children.
            }, [...visited], undefined, signal)
          } catch (e) {
            // A failed child is a tool result, not a rejection. `submitChild`
            // is `_submitJobInternal`, which throws on every fresh dispatch
            // failure — so before this catch existed the ONLY way a loop could
            // read `SUBAGENT_TOOL_FAILED` was a non-conforming store handing
            // back a cached errored row, and every real failure killed the run
            // instead: the model never learned which of its calls failed, or
            // why, and a Pattern's own structured error (`planStepId`,
            // `issues`) died with it.
            //
            // `CHILD_FAILURE_RETHROWN_CODES` is the exhaustive list of what
            // still kills the loop instead, and `signal.aborted` is checked
            // first so an abort that surfaced as some other error is not fed
            // to a model that would only try again.
            const innerCode = (e as { code?: unknown }).code
            if (
              signal.aborted ||
              (typeof innerCode === 'string' && CHILD_FAILURE_RETHROWN_CODES.has(innerCode))
            ) {
              throw e
            }
            // normaliseError is the runtime's own throw → JobError mapping: it
            // reads `.code`, lifts `httpStatus` / `failedModel` / `diagnostic`
            // into details alongside a structured `details` the throw already
            // carried, and preserves `producedAssets` from a sub-agent that
            // failed with partial work. Using it here is what makes the fresh
            // path's payload identical to the cached path's.
            const failure = childToolFailure(normaliseError(e))
            recordToolResult(failure)
            return failure
          }
          if (child.status === 'error') {
            // The CACHED-error path: the child resolved to a stored errored
            // job rather than running (a store whose dedup gate withholds
            // errored rows never produces this).
            const failure = childToolFailure(child.error)
            recordToolResult(failure)
            return failure
          }
          // Envelope: count each successful tool dispatch.
          envelopeToolCount++
          // Record the child's produced assets into this agent context so
          // later references in the loop (or inheriting children) resolve.
          // recordOutput returns the model-facing output with handles stamped
          // (+ origin/from lineage); we forward THAT to the loop — not the raw
          // child.output (assetId+url, no handle), which the projection below
          // drops for lacking a handle. Mirrors what the host's chat path does
          // to job.output: stamp handles, attach lineage.
          const stamped = deps.agentAssetBridge?.recordOutput({
            contextId: agentContextId,
            ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
            toolCallId: callId ?? fullId,
            patternId: fullId,
            resolvedInputs: childAssets,
            output: child.output,
          })
          // Whoever owns the model call owns the projection. This tool-result
          // goes straight into the loop's model context, so it is projected
          // HERE, on both paths — bridge present (stamped) and bridge absent
          // (raw child.output) — rather than left for a host to remember.
          // `InlineRuntime.dispatch()` deliberately does NOT do this: it
          // returns to the host, which needs the real assetIds and URLs.
          //
          // Order matters: project FIRST (drops assetId / url and rebuilds
          // assets[] from the handle whitelist — `projectToolOutputForModel`
          // in @orchestral/core's asset-index.ts is the verifiable assertion
          // point for the no-assetId invariant), sanitize SECOND (scrubs
          // data: URLs / binary runs that survived inside the projected
          // metadata). Same composition as @orchestral/dsh-plugin's tool.ts.
          // DESIGN: project-then-sanitize
          const modelFacing = sanitizeToolOutput(
            projectToolOutputForModel(stamped ?? child.output),
          )
          // Record the tool-result kind into the transcript so resume can
          // replay tool outputs alongside assistant text.
          //
          // What goes in is `modelFacing`, never `child.output`: the transcript
          // is replayed straight back into model context on resume, so it must
          // hold exactly what the model saw the first time. Storing the raw
          // output did two wrong things at once — persisted real assetIds and
          // signed provider URLs in a host store, and then fed a payload the
          // model had never seen into its context on resume, bypassing the
          // projection above.
          recordToolResult(modelFacing)
          return modelFacing
        }

        // Unknown tool name — LLM emitted something not in our catalog.
        // Return as tool_result so the LLM self-corrects on the next step
        // (typically by calling find_pattern to rediscover).
        return {
          code: 'UNKNOWN_TOOL',
          tool: name,
          message: `tool "${name}" not recognized (this subagent's catalog exposes host tools, find_pattern, dispatch_pattern)`,
          hint: 'Use find_pattern to discover Pattern ids, then dispatch_pattern to invoke them.',
        }
      },
    })

    // ── Compose Pattern outputs ────────────────────────────────────────
    // Three mutually-exclusive sources of the candidate output:
    //   • outputExtractor — the author lifts typed output from the final
    //     text (no finish tool was injected for this Pattern).
    //   • a valid finish  — compose the recorded finish payload + run facts.
    //   • neither         — a positive AGENT_INCOMPLETE: the runtime KNOWS
    //     no valid finish arrived, rather than inferring it from the shape of
    //     whatever the loop last said.
    const setErroredEnvelope = (errorMessage: string): void => {
      deps.recordEnvelope(jobId, {
        patternId: pattern.id,
        text: result.text,
        status: 'errored',
        totalToolUseCount: envelopeToolCount,
        totalDurationMs: Date.now() - envelopeStartTs,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(store ? { runId, transcriptId: agentId } : {}),
        errorMessage,
      })
    }

    const extractor = pattern.loop.outputExtractor
    let candidateOutput: unknown
    if (extractor) {
      candidateOutput = extractor(result.text)
    } else if (finishState.value) {
      try {
        candidateOutput = finishSpec!.compose(finishState.value.payload, {
          stepCount: stepCounter,
          ...(result.usage ? { usage: result.usage } : {}),
          deliverables: finishState.value.resolved,
        })
      } catch (e) {
        // Pattern-author bug: compose itself threw — distinct from a shape
        // mismatch so the envelope names the real culprit.
        const msg = `AGENT_FINISH_COMPOSE_THREW: ${pattern.id} — finish.compose threw: ${
          e instanceof Error ? e.message : String(e)
        }`
        setErroredEnvelope(msg)
        throw Object.assign(new Error(msg), { code: 'AGENT_FINISH_COMPOSE_THREW' })
      }
    } else {
      const msg =
        `AGENT_INCOMPLETE: ${pattern.id} — the agent loop ended without a ` +
        `valid ${AGENT_FINISH_TOOL_NAME} call, so no structured outputs exist.`
      setErroredEnvelope(msg)
      throw Object.assign(new Error(msg), { code: 'AGENT_INCOMPLETE' })
    }

    let sanitizedOutput: TOut
    try {
      sanitizedOutput = outputsSchema.parse(candidateOutput) as TOut
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const msg =
        `AGENT_OUTPUT_COMPOSE_MISMATCH: ${pattern.id} — ` +
        (extractor
          ? `loop.outputExtractor's value does not parse against pattern.outputs. Check that outputExtractor returns the declared shape. `
          : `finish.compose's value does not parse against pattern.outputs. Check that compose returns the declared shape. `) +
        errMsg
      setErroredEnvelope(msg)
      throw Object.assign(new Error(msg), { code: 'AGENT_OUTPUT_COMPOSE_MISMATCH' })
    }

    deps.recordEnvelope(jobId, {
      patternId: pattern.id,
      text: result.text,
      status: 'completed',
      totalToolUseCount: envelopeToolCount,
      totalDurationMs: Date.now() - envelopeStartTs,
      ...(result.usage ? { usage: result.usage } : {}),
      // Emit both runId and transcriptId so the host can call
      // `transcriptStore.read(runId, transcriptId)` to fetch full history.
      // Both are required on the success path too — without runId a
      // getAgentEnvelope consumer has nothing to query with.
      ...(store ? { runId, transcriptId: agentId } : {}),
    })
    return sanitizedOutput
  } catch (e) {
    const aborted =
      signal.aborted || (e instanceof DOMException && e.name === 'AbortError')
    // A post-finish infrastructure failure (run() rejected AFTER a valid
    // finish landed: worker death, transport error) must not discard the
    // result — recompose from the recorded finishState and return it. But
    // errors the finalize block ITSELF raised are terminal (their envelope is
    // already set; re-composing would just rethrow the same author bug), so
    // let those pass straight through. AGENT_ASSET_BRIDGE_MISSING joins them:
    // it is a host-config bug raised by the finish interceptor itself and is
    // documented fail-loud, so an earlier valid finish must not mask it.
    const finalizeCode = (e as { code?: unknown }).code
    const isFinalizeError =
      finalizeCode === 'AGENT_INCOMPLETE' ||
      finalizeCode === 'AGENT_FINISH_COMPOSE_THREW' ||
      finalizeCode === 'AGENT_OUTPUT_COMPOSE_MISMATCH' ||
      finalizeCode === 'AGENT_ASSET_BRIDGE_MISSING'
    if (finishState.value && finishSpec && !aborted && !isFinalizeError) {
      // Salvage compose/parse can itself throw (a compose that needs run facts
      // the salvage path can't provide — e.g. usage — or a composed shape that
      // fails outputsSchema). Guard it: a failed salvage must NOT re-enter this
      // branch or mask the real infra failure. Mark the envelope errored and
      // fall through to the rethrow path, which surfaces the ORIGINAL run()
      // error with produced-so-far assetIds attached. `setErroredEnvelope` is
      // scoped to the try body above and unreachable here, so set the errored
      // envelope inline in the same shape as the salvage-success envelope.
      try {
        const salvaged = finishSpec.compose(finishState.value.payload, {
          stepCount: stepCounter,
          deliverables: finishState.value.resolved,
        })
        const parsed = outputsSchema.parse(salvaged) as TOut
        deps.recordEnvelope(jobId, {
          patternId: pattern.id,
          text: '',
          status: 'completed',
          totalToolUseCount: envelopeToolCount,
          totalDurationMs: Date.now() - envelopeStartTs,
          ...(store ? { runId, transcriptId: agentId } : {}),
        })
        return parsed
      } catch (salvageErr) {
        deps.recordEnvelope(jobId, {
          patternId: pattern.id,
          text: '',
          status: 'errored',
          totalToolUseCount: envelopeToolCount,
          totalDurationMs: Date.now() - envelopeStartTs,
          ...(store ? { runId, transcriptId: agentId } : {}),
          errorMessage:
            salvageErr instanceof Error ? salvageErr.message : String(salvageErr),
        })
      }
    }
    // Surface produced-so-far assetIds on the thrown error. The parent
    // records full success output via its own path (the host's turn handler
    // or the parent agent's recordOutput); on whole-agent failure this is
    // the only carrier of the
    // partial output.
    const err = e instanceof Error ? e : new Error(String(e))
    ;(err as { producedAssets?: readonly string[] }).producedAssets =
      deps.agentAssetBridge?.recordedAssetIds(agentContextId) ?? []
    throw err
  }
}

/**
 * Compute the STATIC excludeIds for an AgentPattern catalog (self + default
 * subagent blocklist matches).
 * Result depends only on registry contents + pattern.id (no dynamic
 * dispatch state), so the catalog bytes are stable across all dispatches
 * of the same Pattern → prompt cache hits across LLM turns within the
 * agent loop.
 *
 * Note: this does NOT include the ancestor chain — that's caught at
 * runtime in onToolCall to keep the catalog cacheable.
 *
 * There is no per-Pattern opt-out. An author who lists an `agent_` id in
 * `loop.toolPatternIds` used to keep it in the catalog while `onToolCall`
 * refused the very same id, so the catalog advertised a tool the model could
 * find and never call. The blocklist is the one rule; opening recursion means
 * changing the blocklist itself, not naming an id past it.
 */
export function computeStaticAgentExcludes(
  registry: PatternRegistry,
  selfId: PatternId,
): PatternId[] {
  const out: PatternId[] = [selfId]
  // Expand idPrefixes into concrete ids; iterate registry.values().
  for (const p of registry.values()) {
    if (p.id === selfId) continue // self already in out
    if (matchSubagentBlocklist(p.id)) out.push(p.id)
  }
  return out
}
