// In-process Runtime implementation.
//
// Design highlights:
//  • The runtime resolves a ModelCapability via the Router and invokes
//    `modelCap.call(effectiveInput, ctx)` — primary path only.
//  • Transient retry happens inside the Router via
//    `ResolveContext.excludeModel` accumulation.
//  • Cross-Pattern recovery is declarative via `Pattern.alternatives[*]`
//    evaluated in the satisfiability phase.
//  • Idempotency uses a canonical JSON hash (drops Date / Map / Buffer hazards).
//  • Parent AbortSignal propagates into every child `submitJob`.
//  • Alternative chain carries a `visited` Set so A→B→A loops fail loudly.

import { randomUUID } from 'node:crypto'

import type {
  AgentDispatchEnvelope,
  AgentPattern,
  Alternative,
  AlternativeAppliesWhen,
  AskUserHandler,
  AssetNeed,
  AtomicPattern,
  CallEvents,
  Capability,
  CapabilityRouter,
  DispatchContext,
  DispatchMiddleware,
  ExecutionContext,
  Job,
  JobEvent,
  JobError,
  JobSpec,
  JobStatus,
  JobStore,
  MetaPattern,
  ModelTag,
  Pattern,
  PatternId,
  PatternRegistry,
  ResolveContext,
  ResolvedAssetRef,
  Runtime,
  Semantics,
  SystemPromptContext,
  TranscriptMessage,
  TranscriptStore,
  Unsubscribe,
  DispatchResult,
} from '@orchestral/core'
import { NoModelForCapabilityError } from '@orchestral/core'
import {
  AGENT_FINISH_TOOL_NAME,
  buildAlwaysLoadDescriptors,
  buildFinishDescriptor,
  buildCatalogDescriptors,
  type BuildCatalogDescriptorsOptions,
  DEFAULT_AGENT_FINISH_SPEC,
  DEFAULT_SUBAGENT_BLOCKLIST,
  DispatchPatternInputSchema,
  FindPatternInputSchema,
  handleFindPattern,
  isDispatchError,
  PatternSearchIndex,
  resolveDispatchTarget,
} from '@orchestral/core'

import { deriveIdempotencyKey } from './idempotency'
import { forkExecutionContext } from './fork-context'
import type {
  AgentChatMessage,
  AgentRunImpl,
  AgentToolDescriptor,
} from './agent-run'
import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaSharedState,
} from './meta-execution-context'

/** Default cap on `Pattern.alternatives` recursion depth. */
const DEFAULT_MAX_ALTERNATIVE_DEPTH = 4

/** Default cap on in-Router retries after `excludeModel` accumulation. */
const DEFAULT_MAX_ROUTER_RETRIES = 3

/**
 * Default cap on agent/meta nesting depth.
 *
 * 2 = chat-turn (the top-level host orchestration entry, depth=0) → 1 subagent
 * (depth=1) → blocked at depth=2. Together with the default blocklist (which
 * excludes `agent_*`-prefixed Patterns from subagent catalogs), this gives
 * defence-in-depth against recursion.
 *
 * A Pattern author who wants to open a recursive path (e.g. director →
 * cinematographer → camera-operator) must (a) explicitly raise maxAgentDepth
 * and (b) list the specific `agent_`-prefixed Pattern in toolPatternIds.
 */
const DEFAULT_MAX_AGENT_DEPTH = 2

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
 * Render the agent allowlist's `exposureMode: 'always-load'` Patterns as direct
 * tools (inline core), and return their ids so they can be excluded from the
 * find_pattern corpus. Assembled in this package (next to
 * buildCatalogDescriptors); the host only prepends host tools. With no
 * deriveProviderOptionsZod, this falls back to the base schema (a degraded but
 * acceptable mode).
 */
export function buildAgentInlineCore(
  whitelist: readonly PatternId[],
  registry: { get(id: PatternId): Pattern | undefined },
): { descriptors: AgentToolDescriptor[]; inlineIds: Set<PatternId> } {
  const patterns: Pattern[] = []
  for (const id of whitelist) {
    const p = registry.get(id)
    if (p) patterns.push(p)
  }
  const descriptors = buildAlwaysLoadDescriptors(patterns)
  const inlineIds = new Set<PatternId>(descriptors.map((d) => d.name as PatternId))
  return { descriptors, inlineIds }
}

/**
 * Host-supplied builder for the ResolveContext given a JobSpec. Called once
 * per dispatch so the host can read the live session row / project defaults
 * at resolution time. Keeps host-specific override layers (node / session /
 * global) outside this package's interface.
 */
export type ResolveCtxProvider = (spec: JobSpec) => ResolveContext

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
 *     assetIds (`recordedAssetIds`).
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
   * from `resolvedInputs`). The caller forwards THIS return value to the model
   * history — never the raw adapter output, whose elements carry assetId/url
   * but no handle and would therefore be dropped entirely by the downstream
   * `projectToolOutputForModel` D3 projection.
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
}

export interface InlineRuntimeInit {
  store: JobStore
  registry: PatternRegistry
  router: CapabilityRouter
  resolveCtxProvider?: ResolveCtxProvider
  /**
   * Fires synchronously inside `submitJob` after the runtime mints a jobId
   * and inserts the queued row, BEFORE dispatch. Lets the host correlate
   * its own request id to the runtime jobId so it can call cancelJob
   * mid-flight. Exceptions are swallowed (observational only).
   */
  onJobCreated?: (jobId: string, spec: JobSpec) => void
  /**
   * Cap on `Pattern.alternatives` recursion depth. Defaults to 4. Tune
   * down for tighter latency budgets; tune up only if you genuinely have
   * deep fallback chains (rare).
   */
  maxAlternativeDepth?: number
  /**
   * Cap on in-Router retries after `excludeModel` accumulation per
   * dispatch attempt. Defaults to 3.
   */
  maxRouterRetries?: number
  /**
   * Cap on agent/meta nesting depth (ancestor chain length at `dispatchAgent`
   * entry). Defaults to 2.
   *
   * Defence-in-depth alongside the default subagent blocklist (which hides
   * `agent_*` Patterns from subagent catalogs at the source). Pattern
   * authors who legitimately need deeper recursion (rare) can bump this.
   */
  maxAgentDepth?: number
  /**
   * Ordered list of cross-cutting middleware (moderation, cache, cost
   * tracking, logging, metrics). Hooks run around the dispatch core:
   *   beforeDispatch (registration order)
   *     → dispatch
   *     → afterDispatch (REVERSE order — Express/Koa onion model)
   * Errors thrown in middleware abort dispatch and propagate through
   * `onError` of subsequent middleware in registration order.
   */
  middleware?: readonly DispatchMiddleware[]
  /**
   * Host-injected LLM loop executor for AgentPattern dispatch.
   * Required iff any registered Pattern has `kind: 'agent'`; dispatch
   * throws `AGENT_RUN_IMPL_NOT_INJECTED` if an agent-kind dispatch fires
   * without this wired. Typical host: ai-sdk `ToolLoopAgent` over IPC
   * to a worker process. Atomic / meta dispatch does NOT consult this.
   * @alpha
   */
  agentRunImpl?: AgentRunImpl
  /**
   * Optional subagent transcript persistence. When supplied, dispatchAgent
   * appends each AgentLoopStep to the store at message-boundary granularity
   * (NOT at SSE token delta). Required for:
   *   • Crash recovery of long-running agents (the host process may exit or
   *     hang while the agent is mid-loop)
   *   • async agent resume (abortMode='independent' UX)
   *   • Anthropic Extended Thinking reasoning round-trip prep
   *
   * Default behaviour without this: no persistence; the agent runs ephemerally
   * and parents see only the final sanitized output. InMemoryTranscriptStore
   * ships as the default in-process impl (test / dev); a durable host injects
   * its own persistent transcript store (e.g. SQLite-backed).
   */
  transcriptStore?: TranscriptStore
  /**
   * Host seam — per-agent asset resolution / recording / announcement.
   * Absent in substrate-only tests (dispatchAgent then runs with no inner
   * asset resolution).
   * @alpha
   */
  assetBridge?: AgentAssetBridge
  /**
   * Host HITL seam. The runtime calls it with an AskUserRequest whenever a
   * MetaPattern.compose() parks on `ctx.askUser`, and awaits the returned
   * promise for the user's answer. Absent in headless callers that never invoke
   * HITL — `ctx.askUser` then throws `ASK_USER_NOT_SUPPORTED`.
   */
  askUser?: AskUserHandler
  /**
   * Options forwarded to `buildCatalogDescriptors` when the runtime assembles
   * an agent loop's tool surface. The stock catalog copy already describes what
   * the shipped implementation does, so most hosts leave this unset; it exists
   * for a host that has swapped out a piece of that behaviour (see
   * `BuildCatalogDescriptorsOptions.slotDefaultNote`) and must keep the
   * agent-loop descriptors truthful and in step with its own chat-turn catalog.
   */
  catalogOptions?: BuildCatalogDescriptorsOptions
}

/**
 * Best-effort mapping from a stored TranscriptMessage back into an
 * AgentChatMessage suitable for re-seeding an agent loop on resume.
 *
 * Caveats:
 *   • The transcript captures the host's agent-loop step projection — not raw
 *     provider messages — so we lose `tool_use_id` pairing + reasoning
 *     blocks. The resumed LLM sees previous text + tool outputs as separate
 *     turns rather than the original interleaved structure.
 *   • A future reasoning round-trip will eventually let `raw` hold byte-
 *     exact provider messages, at which point this mapping can preserve
 *     full fidelity. Until then this is "good enough resume".
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
 * In-process Runtime. Submits a Job row, runs the resolved
 * ModelCapability.call synchronously in the caller's tick, writes back the
 * final status. No durable queue, no cross-process resume — the host
 * process's lifetime bounds the lifetime of these jobs.
 */
export class InlineRuntime implements Runtime {
  private readonly store: JobStore
  private readonly registry: PatternRegistry
  private readonly router: CapabilityRouter
  private readonly resolveCtxProvider?: ResolveCtxProvider
  private readonly subscribers = new Map<string, Set<(ev: JobEvent) => void>>()
  /** Per-job AbortController; cancelJob aborts via this map. */
  private readonly controllers = new Map<string, AbortController>()
  private readonly onJobCreated?: (jobId: string, spec: JobSpec) => void
  private readonly maxAlternativeDepth: number
  private readonly maxRouterRetries: number
  private readonly maxAgentDepth: number
  private readonly middleware: readonly DispatchMiddleware[]
  private readonly agentRunImpl?: AgentRunImpl
  private readonly transcriptStore?: TranscriptStore
  private readonly agentAssetBridge?: AgentAssetBridge
  private readonly askUser?: AskUserHandler
  private readonly catalogOptions?: BuildCatalogDescriptorsOptions
  /**
   * Capture the per-dispatch envelope under the jobId of the agent dispatch.
   * Populated inside dispatchAgent on completion (both
   * success and error paths). Host retrieves via `getAgentEnvelope(jobId)`
   * after observing the corresponding `job:settled` event.
   *
   * Lifecycle burden: entries live until the host calls
   * `disposeAgentEnvelope(jobId)` (or the job is cancelled) — the map grows
   * one entry per agent dispatch otherwise. Both methods are
   * InlineRuntime-only (not on the Runtime contract).
   */
  private readonly agentEnvelopes = new Map<string, AgentDispatchEnvelope>()

  constructor(init: InlineRuntimeInit) {
    this.store = init.store
    this.registry = init.registry
    this.router = init.router
    this.resolveCtxProvider = init.resolveCtxProvider
    this.onJobCreated = init.onJobCreated
    this.maxAlternativeDepth =
      init.maxAlternativeDepth ?? DEFAULT_MAX_ALTERNATIVE_DEPTH
    this.maxRouterRetries =
      init.maxRouterRetries ?? DEFAULT_MAX_ROUTER_RETRIES
    this.maxAgentDepth = init.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH
    this.middleware = init.middleware ?? []
    this.agentRunImpl = init.agentRunImpl
    this.transcriptStore = init.transcriptStore
    this.agentAssetBridge = init.assetBridge
    this.askUser = init.askUser
    this.catalogOptions = init.catalogOptions
  }

  /**
   * Runs the dispatch to completion before resolving — the returned Job is
   * already terminal and every job event has fired. Subscribe from the
   * `onJobCreated` init hook to observe progress; subscribing after this
   * promise resolves observes nothing.
   *
   * One exception: on an idempotency dedup hit this returns the existing
   * canonical row as-is, which may still be `queued` / `running` with a null
   * output — the prior submit owns that dispatch and this call never joins it.
   * A caller that needs a terminal Job must check `status` and, when it isn't
   * terminal, `subscribe(job.id, ...)` or poll `pollJob(job.id)` for the
   * outcome.
   */
  async submitJob<TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
  ): Promise<Job<TIn, TOut>> {
    // Public entry seeds ancestors = []. Internal recursive call-sites
    // (dispatchMeta sub-steps, dispatchAgent.onToolCall)
    // forward the calling chain via `_submitJobInternal` so descendants can
    // see every ancestor Pattern for runtime cycle / depth checks.
    return this._submitJobInternal<TIn, TOut>(spec, [], undefined, undefined, undefined)
  }

  /**
   * Async agent dispatch. Fire-and-forget: returns `{ jobId }` as soon as the
   * queued row is INSERTed (or, on a dedup hit,
   * the existing job's id). The agent loop runs in the background; observe
   * progress + terminal state via `runtime.subscribe(jobId, ...)`. Same code
   * path as `submitJob` (jobs table + idempotency dedup + pub-sub stay
   * unchanged) but stamps `jobKind: 'agent'` on the row so the host can
   * cheaply filter Activity Hub views / cross-session listeners without
   * joining against the pattern registry.
   *
   * Promise contract:
   *   • RESOLVES with `{ jobId }` once the row is addressable. The dispatch
   *     itself continues in the background — do NOT await for completion.
   *   • REJECTS only for pre-INSERT errors: `PATTERN_NOT_REGISTERED`, store
   *     insert exceptions (disk full / DB locked), or a bug in
   *     `insertIfAbsent`. Anything after INSERT — middleware reject,
   *     provider failures, agent loop crashes — surfaces via the job row's
   *     `status='error'` and the `job:failed` / `job:cancelled` events to
   *     subscribers, NOT as a Promise rejection.
   *
   * The actual long-running loop is still driven by the regular
   * `dispatchAgent` path inside `_submitJobInternal`; the runtime stays
   * AgentRunImpl-agnostic and lets the host decide whether to wire its
   * `AgentRunImpl.run` to an in-process ToolLoopAgent (sync path) or to an
   * async worker handler that surfaces lifecycle frames as progress events.
   */
  async submitAgentAsync<TIn = unknown>(
    spec: JobSpec<TIn>,
  ): Promise<{ jobId: string }> {
    return new Promise<{ jobId: string }>((resolve, reject) => {
      let captured = false
      const onJobCreated = (jobId: string): void => {
        if (captured) return
        captured = true
        resolve({ jobId })
      }
      // Detached: `_submitJobInternal` continues after we resolve. Catch
      // rejections so:
      //   (a) pre-INSERT errors (onJobCreated never fired) → reject.
      //   (b) post-INSERT errors (already resolved) → swallow; the failure
      //       is already on the job row and observable via subscribe.
      // Without the catch, post-INSERT throws would surface as unhandled
      // promise rejections.
      void this._submitJobInternal<TIn>(
        { ...spec, jobKind: 'agent' as const },
        [],
        undefined,
        undefined,
        undefined,
        { onJobCreated },
      ).catch((err) => {
        if (!captured) reject(err)
      })
    })
  }

  /**
   * Internal submitJob with ancestor chain — recursion bookkeeping kept
   * off the public surface (JobSpec stays caller-clean).
   *
   * `metaSharedState` threads the idempotency cache + step counter + stepId-
   * uniqueness set from a parent meta into a nested meta dispatch.
   * `undefined` (the default) means "start a fresh state" — used by public
   * `submitJob`, by `ctx.submitJob` escape hatch, and by alternative dispatch.
   *
   * `parentSignal` is the abort signal of the dispatching parent — meta's
   * controller.signal for `ctx.step` children,
   * agent's controller.signal for `onToolCall` sub-dispatches. When non-null
   * (and the child is not an `abortMode: 'independent'` agent), the child
   * controller subscribes to it so `cancelJob(parentJobId)` cascades into
   * every descendant. `undefined` means "top-level submit" — no cascade.
   *
   * The previous implementation used a `parentSignals` Map keyed by sessionId,
   * but no code path ever populated it; effectively cascade was dead. The
   * explicit param threads the actual controller signal through the call
   * chain so the cascade really works.
   */
  private async _submitJobInternal<TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
    ancestors: readonly PatternId[],
    metaSharedState?: MetaSharedState,
    parentSignal?: AbortSignal,
    // Parent dispatch's DispatchContext, forked (not inherited wholesale) into
    // this dispatch's ctx so child asset/ambient policy lives in
    // `forkExecutionContext`. `undefined` = top-level / no parent ctx; the
    // atomic path then forks from a fresh `{ signal, assets: [] }` seed.
    parentCtx?: DispatchContext,
    // Per-call hook that fires synchronously right after
    // the queued row INSERT (and right after a dedup hit, which also returns
    // an addressable job row). Distinct from the constructor-level
    // `InlineRuntimeInit.onJobCreated`: that one is the host's persistent
    // correlation hook (host request-id → jobId map), this one is the
    // caller's one-shot capture for fire-and-forget dispatch — `submitAgentAsync`
    // uses it to resolve its `Promise<{ jobId }>` BEFORE awaiting the agent
    // loop. Exceptions are swallowed (observational only); the hook MUST NOT
    // alter dispatch flow.
    opts?: { onJobCreated?: (jobId: string) => void },
  ): Promise<Job<TIn, TOut>> {
    const pattern = this.registry.get(spec.patternId)
    if (!pattern) {
      throw new Error(`PATTERN_NOT_REGISTERED: ${spec.patternId}`)
    }

    // ── Idempotency Layer-1 dedup
    const key =
      spec.idempotencyKey ??
      deriveIdempotencyKey({
        patternId: spec.patternId,
        input: spec.input,
        assets: spec.assets,
        sessionId: spec.sessionId,
        stepIndex: spec.stepIndex,
      })

    // ── Insert queued row + emit event
    const id = randomUUID()
    const now = Date.now()
    const queued: Job<TIn, TOut> = {
      id,
      patternId: spec.patternId,
      idempotencyKey: key,
      status: 'queued',
      input: spec.input,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      sessionId: spec.sessionId,
      // When the caller (e.g. submitAgentAsync) sets jobKind, forward it onto
      // the queued row so the persisted column matches the
      // spec discriminator. Undefined falls through to the store's own
      // default of 'pattern'.
      ...(spec.jobKind ? { jobKind: spec.jobKind } : {}),
    }
    // Atomic dedup-or-create — the one and only dedup gate. A separate
    // `findByIdempotencyKey` first would be pure overhead: it applies the same
    // canonical rule this call already applies, and it cannot decide anything,
    // because between its `await` and this write another submit with the same
    // key can run the same lookup, also miss, and dispatch a second time
    // (twice the provider spend). The store settles it in one step: we either
    // own the key or we get handed the row that does.
    const winner = await this.store.insertIfAbsent(queued as Job)
    if (winner.id !== id) {
      // Dedup hit — a sequential repeat and a lost race land here alike, and
      // the row we hand back is the canonical one (possibly still in flight).
      //
      // Async-agent dedup re-attach. For a non-agent dedup hit the
      // constructor-level onJobCreated does NOT fire: it's a per-row-INSERT
      // hook and a dedup hit inserts nothing, so firing it would double-bind
      // the inner-job cascade trackers. But an async-agent dispatch needs its
      // cross-session fan-out subscription attached for the returned jobId,
      // and that subscription lives ONLY in the constructor hook's
      // `jobKind === 'agent'` branch (host side). The host branch is
      // idempotent (guarded per-jobId), so firing it here on an agent dedup
      // hit re-attaches a missing subscription without double-subscribing a
      // live one. Order before the per-call capture so the host fan-out is
      // wired before submitAgentAsync resolves its jobId.
      if (spec.jobKind === 'agent' && this.onJobCreated) {
        try { this.onJobCreated(winner.id, spec as JobSpec) }
        catch (e) { console.warn(`[runtime] onJobCreated (agent dedup) threw for ${winner.id}:`, e) }
      }
      // Fire the per-call capture so a fire-and-forget caller (submitAgentAsync)
      // still sees the addressable jobId.
      if (opts?.onJobCreated) {
        try { opts.onJobCreated(winner.id) }
        catch (e) { console.warn(`[runtime] opts.onJobCreated threw for ${winner.id}:`, e) }
      }
      return winner as Job<TIn, TOut>
    }

    if (this.onJobCreated) {
      try { this.onJobCreated(id, spec as JobSpec) }
      catch (e) { console.warn(`[runtime] onJobCreated threw for ${id}:`, e) }
    }
    // Per-call capture fires AFTER the constructor-level hook so the host
    // correlation map (host requestId → jobId) is populated first, then
    // the fire-and-forget caller resolves its Promise.
    if (opts?.onJobCreated) {
      try { opts.onJobCreated(id) }
      catch (e) { console.warn(`[runtime] opts.onJobCreated threw for ${id}:`, e) }
    }

    // ── Middleware: beforeDispatch. Runs while the row is still 'queued'
    // so a short-circuit / reject never observes a 'running' phantom.
    // Use a mutable spec ref so successive middleware can stack
    // modifications (each receives the prior middleware's output).
    let effectiveSpec: JobSpec<TIn> = spec
    let shortCircuit: { output: unknown } | null = null
    let rejected: JobError | null = null
    let beforeErr: { err: unknown; normalised: JobError } | null = null
    for (let i = 0; i < this.middleware.length; i++) {
      const mw = this.middleware[i]
      if (!mw.beforeDispatch) continue
      try {
        const decision = await mw.beforeDispatch(effectiveSpec as JobSpec)
        if (!decision || decision.kind === 'continue') {
          if (decision?.spec) effectiveSpec = decision.spec as JobSpec<TIn>
          continue
        }
        if (decision.kind === 'reject') {
          rejected = { code: decision.code, message: decision.message }
          break
        }
        if (decision.kind === 'short-circuit') {
          shortCircuit = { output: decision.output }
          break
        }
      } catch (err) {
        // Middleware threw mid-beforeDispatch chain. Run remaining
        // onError handlers in registration order, mark errored, rethrow.
        beforeErr = {
          err,
          normalised: normaliseError(err, 'MIDDLEWARE_BEFORE_FAILED'),
        }
        await this.runOnErrorChain(id, beforeErr.normalised, i + 1)
        break
      }
    }

    if (beforeErr) {
      await this.markErrored(id, beforeErr.normalised)
      throw beforeErr.err instanceof Error
        ? beforeErr.err
        : new Error(`${beforeErr.normalised.code}: ${beforeErr.normalised.message}`)
    }
    if (rejected) {
      await this.markErrored(id, rejected)
      throw new Error(`${rejected.code}: ${rejected.message}`)
    }

    // Short-circuit path: skip dispatch entirely, mark done with the
    // supplied output. Used by cache-hit middleware.
    if (shortCircuit) {
      await this.store.update(id, {
        status: 'done',
        output: shortCircuit.output,
        updatedAt: Date.now(),
      })
      const final = (await this.store.get(id)) as Job<TIn, TOut> | null
      if (!final) throw new Error(`JOB_LOST_AFTER_COMPLETION: ${id}`)
      this.fanout(id, { type: 'job:completed', job: final })
      return final
    }

    await this.store.update(id, { status: 'running', updatedAt: Date.now() })
    this.fanout(id, { type: 'job:started', job: { ...queued, status: 'running' } })

    // ── AbortController; propagate parent signal if this is a sub-job.
    //
    // `abortMode: 'independent'` on AgentPattern.loop opts the child out of the
    // parent-signal cascade. The child gets a fresh controller registered under
    // its jobId so `runtime.cancelJob(childJobId)` still works, but
    // parent.cancelJob does NOT cascade. Use case: an async long-running agent
    // whose parent (a host process, a UI turn) may exit while the child should
    // keep running and be re-attached via JobSpec.resumeFromRunId later.
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const isIndependentAgent =
      pattern.kind === 'agent' &&
      (pattern as AgentPattern<unknown, unknown>).loop?.abortMode === 'independent'
    if (parentSignal && !isIndependentAgent) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      let output: TOut = await this.dispatch<TIn, TOut>(
        id,
        pattern,
        effectiveSpec,
        controller.signal,
        // Seed visited with the full ancestor chain + self. Top-level
        // submitJob passes ancestors=[], so visited = {patternId}. Recursive
        // entries from dispatchMeta /
        // dispatchAgent.onToolCall carry the full calling chain so descendants
        // can detect ancestor cycles + enforce maxAgentDepth.
        new Set<PatternId>([...ancestors, effectiveSpec.patternId]),
        0,
        metaSharedState,
        parentCtx,
      )

      if (controller.signal.aborted) {
        throw new Error('CANCELLED: job cancelled before completion')
      }

      // ── Middleware: afterDispatch (REVERSE order — onion model).
      // Errors here are treated as MIDDLEWARE_AFTER_FAILED dispatch failures
      // and rethrown with that override code so the outer catch handles
      // markErrored + onError chain in a single, consistent place.
      const snapshot: Job<TIn, TOut> = {
        ...queued,
        status: 'running',
        output: output as TOut,
      }
      for (let i = this.middleware.length - 1; i >= 0; i--) {
        const mw = this.middleware[i]
        if (!mw.afterDispatch) continue
        try {
          const next = await mw.afterDispatch(snapshot as Job, output)
          if (next !== undefined) {
            output = next as TOut
            snapshot.output = next as TOut
          }
        } catch (err) {
          throw new MiddlewareAfterFailure(err)
        }
      }

      await this.store.update(id, { status: 'done', output, updatedAt: Date.now() })
      const final = (await this.store.get(id)) as Job<TIn, TOut> | null
      if (!final) throw new Error(`JOB_LOST_AFTER_COMPLETION: ${id}`)
      this.fanout(id, { type: 'job:completed', job: final })
      return final
    } catch (err) {
      if (controller.signal.aborted) {
        const current = await this.store.get(id)
        if (current && (current.status === 'queued' || current.status === 'running')) {
          await this.store.update(id, {
            status: 'cancelled',
            error: null,
            updatedAt: Date.now(),
          })
          const next = await this.store.get(id)
          if (next) this.fanout(id, { type: 'job:cancelled', job: next })
        }
        throw err instanceof Error ? err : new Error(`CANCELLED: ${String(err)}`)
      }
      const isAfterFailure = err instanceof MiddlewareAfterFailure
      const inner = isAfterFailure ? (err as MiddlewareAfterFailure).innerCause : err
      const e = normaliseError(
        inner,
        isAfterFailure ? 'MIDDLEWARE_AFTER_FAILED' : undefined,
      )
      await this.runOnErrorChain(id, e)
      await this.markErrored(id, e)
      throw inner instanceof Error
        ? inner
        : new Error(`${e.code}: ${e.message}`)
    } finally {
      this.controllers.delete(id)
    }
  }

  /**
   * Run middleware.onError handlers in registration order, starting from
   * `startIndex` (default 0). The `startIndex` knob is used when a
   * beforeDispatch hook itself threw — only the SUBSEQUENT middleware
   * should observe the failure, never the one that raised it.
   * Each callback is isolated — a throw in one onError handler logs and
   * proceeds to the next, never blocking observers downstream.
   */
  private async runOnErrorChain(
    id: string,
    err: JobError,
    startIndex = 0,
  ): Promise<void> {
    if (this.middleware.length === 0) return
    const job = (await this.store.get(id)) ?? undefined
    if (!job) return
    for (let i = startIndex; i < this.middleware.length; i++) {
      const mw = this.middleware[i]
      if (!mw.onError) continue
      try {
        await mw.onError(job, err)
      } catch (e) {
        console.error(`[runtime] middleware.onError threw for ${id}:`, e)
      }
    }
  }

  /**
   * Resolve pattern (atomic vs meta) + Router and dispatch. Recurses through
   * Pattern.alternatives on satisfiability failure with a visited-Set guard.
   * `jobId` rides through so the model.call event callbacks (CallEvents) can
   * fan out as Job events under the right id.
   */
  private async dispatch<TIn, TOut>(
    jobId: string,
    pattern: Pattern,
    spec: JobSpec<TIn>,
    signal: AbortSignal,
    visited: Set<PatternId>,
    depth: number,
    metaSharedState?: MetaSharedState,
    // Parent dispatch ctx forwarded for the atomic fork seed.
    parentCtx?: DispatchContext,
  ): Promise<TOut> {
    if (depth > this.maxAlternativeDepth) {
      throw new Error(`ALTERNATIVE_DEPTH_EXCEEDED: ${pattern.id}`)
    }

    if (pattern.kind === 'meta') {
      return this.dispatchMeta<TIn, TOut>(
        jobId,
        pattern,
        spec,
        signal,
        visited,
        depth,
        metaSharedState,
      )
    }

    if (pattern.kind === 'agent') {
      return this.dispatchAgent<TIn, TOut>(
        jobId,
        pattern as AgentPattern<TIn, TOut>,
        spec,
        signal,
        visited,
      )
    }

    const atomic = pattern as AtomicPattern<TIn, TOut>

    // Dispatch always takes the primary path, routing via
    // primary.modelTags. Capability sub-modes flow through input.references +
    // typed providerOptions instead.
    const requiredTags: readonly ModelTag[] = atomic.primary.modelTags ?? []
    const preserves: readonly string[] = []
    const effectiveInput = spec.input

    const baseCtx = this.resolveCtxProvider?.(spec) ?? {}

    // Satisfiability phase: proactive check (consults Router).
    const sat = this.router.checkSatisfiable(
      atomic.id as Capability,
      requiredTags,
      baseCtx,
    )

    if (!sat.ok) {
      const alt = this.pickAlternative(atomic, baseCtx, requiredTags, preserves)
      if (!alt) {
        // Terminal no-model error. Route through router.resolve so the error
        // is built at the single router seam — a host router that decorates
        // resolve() errors (e.g. with UI remedy text) covers this path too,
        // and the message stays consistent with every other no-model throw.
        this.router.resolve(atomic.id as Capability, requiredTags, baseCtx)
        // resolve() unexpectedly succeeded right after checkSatisfiable said
        // no (racing catalog change) — still unavailable this dispatch.
        throw new NoModelForCapabilityError(
          atomic.id as Capability,
          requiredTags,
          sat.reason,
        )
      }
      return this.runAlternative<TIn, TOut>(jobId, alt, spec, signal, visited, depth + 1, parentCtx)
    }

    // Dispatch phase — Router resolve + ModelCapability.call with accumulated
    // excludeModel for in-router retry on transient failures.
    const excludeModel: string[] = [...(baseCtx.excludeModel ?? [])]
    let lastErr: unknown = null
    // Build the CallEvents bridge once per dispatch — the call adapter
    // fires these inside provider SDK callbacks (fal-queue progress,
    // runway task update); the runtime fans them out as Job events.
    const events = this.buildCallEvents(jobId)
    // DispatchContext the adapter reads. `assets` is the resolution-pass output
    // the host pre-resolved into spec.assets (the LLM only ever filled handles);
    // `signal` carries the parent abort. providerOptions is the host's validated
    // UI-default providerOptions (spec.providerOptions); the adapter merges it
    // under the LLM-explicit input.providerOptions.
    // Route through forkExecutionContext (the single child-ctx policy site):
    // forking a fresh `{ signal, assets: [] }` seed with these full overrides
    // yields `{ signal, assets: spec.assets ?? [], providerOptions?, sessionId? }`.
    // dispatchMeta's ExecutionContext construction is intentionally NOT routed
    // through fork here (meta owns its own builder).
    const dispatchCtx: DispatchContext = forkExecutionContext(
      parentCtx ?? { signal, assets: [] },
      {
        signal,
        assets: spec.assets ?? [],
        ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      },
    )
    // Synchronous permission gate (NOT a HITL seam — mid-run "ask the user" lives
    // only on MetaPattern.compose via ctx.askUser; atomic confirms, e.g. cost, are
    // a host dispatch-policy concern). Read checkPermissions off `pattern` (narrowed
    // to the AtomicPattern *spec* interface, which carries the optional PatternBase
    // hook) — the class type `atomic` is cast to does not redeclare it.
    if (typeof pattern.checkPermissions === 'function') {
      const perm = await pattern.checkPermissions(effectiveInput, dispatchCtx)
      if (!perm.ok) throw new Error(`PERMISSION_DENIED: ${perm.reason}`)
    }

    // Fallback-walk depth: the host sets baseCtx.maxRetries from the configured
    // rankedModels length so the whole order is walked; otherwise the default
    // transient-retry budget applies. (Single counter — conflates transient retry
    // with fallback-to-next; see ResolveContext.maxRetries doc.)
    const retryBound = baseCtx.maxRetries ?? this.maxRouterRetries
    for (let attempt = 0; attempt <= retryBound; attempt++) {
      if (signal.aborted) throw new Error('CANCELLED')
      const ctx: ResolveContext = { ...baseCtx, excludeModel }
      let model
      try {
        model = this.router.resolve(atomic.id as Capability, requiredTags, ctx)
      } catch (e) {
        // Router exhausted — fall through to alternatives. Preserve any
        // prior model.call error: when retry has pushed the pinned model into
        // excludeModel, router throws MODEL_EXCLUDED as a symptom; the real
        // cause is the underlying provider error from attempt 0's call
        // (auth / endpoint / network / model not supported). Overwriting
        // lastErr here would mask that and chat UI shows the misleading
        // "model excluded" instead of "not supported model for image gen".
        if (!lastErr) lastErr = e
        break
      }
      try {
        // Primary path only. Pass the DispatchContext — the adapter reads
        // ctx.assets (resolved assetIds) + ctx.signal; the LLM never saw raw
        // assetIds. events bridge
        // progress/artifact callbacks into Job events; adapter authors that
        // don't have progress info simply don't fire.
        const result = await model.call<TIn, DispatchResult<TOut>>(
          effectiveInput,
          dispatchCtx,
          events,
        )
        if (result && typeof result === 'object' && 'output' in result) {
          return (result as DispatchResult<TOut>).output
        }
        return result as unknown as TOut
      } catch (e) {
        lastErr = e
        // Stamp the failed model onto the error before the loop moves on —
        // normaliseError lifts it (plus any httpStatus the host attached) into
        // JobError.details so the host can derive the exclusion set for the
        // LLM's retry without parsing the message text. ??= keeps the FIRST
        // failure's model when later attempts re-throw the same object.
        if (e instanceof Error) {
          ;(e as Error & { failedModel?: string }).failedModel ??=
            `${model.provider}:${model.modelId}`
        }
        // Print the inner provider error before adding to excludeModel —
        // otherwise the next attempt throws MODEL_EXCLUDED (because pinned
        // model is now in excludeModel) and the real cause (auth / network /
        // model error) gets masked behind a misleading "model excluded" message.
        console.error(
          `[inline-runtime] model.call failed for ${model.provider}:${model.modelId} (cap=${atomic.id}, attempt=${attempt}):`,
          e,
        )
        // Add failed model to excludeModel for next retry
        excludeModel.push(`${model.provider}:${model.modelId}`)
        continue
      }
    }

    // Router/model exhausted — fall through to Pattern.alternatives
    const alt = this.pickAlternative(atomic, baseCtx, requiredTags, preserves)
    if (!alt) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`DISPATCH_EXECUTE_FAILED: ${String(lastErr)}`)
    }
    return this.runAlternative<TIn, TOut>(jobId, alt, spec, signal, visited, depth + 1, parentCtx)
  }

  private async dispatchMeta<TIn, TOut>(
    jobId: string,
    pattern: Pattern,
    spec: JobSpec<TIn>,
    signal: AbortSignal,
    visited: Set<PatternId>,
    depth: number,
    inheritedSharedState?: MetaSharedState,
  ): Promise<TOut> {
    // meta.compose is async (params, ctx) => Promise<O>. Build the
    // ExecutionContext, closing `visited` (the ancestor chain) into ctx.step so
    // sub-Pattern dispatches automatically go through _submitJobInternal with
    // the ancestor chain attached.
    const meta = pattern as MetaPattern<unknown, unknown>
    if (typeof meta.compose !== 'function') {
      throw new Error(`META_PATTERN_NO_COMPOSE: ${meta.id}`)
    }
    void depth // depth check lives in dispatchAgent; meta self-recursion is caught via visited

    // Inherit the caller's shared state when this is a nested meta dispatch
    // (the parent threaded it through `ctx.step → _submitJobInternal → dispatch
    // → dispatchMeta`); otherwise start fresh (top-level meta or
    // alternative-redirected meta).
    const sharedState = inheritedSharedState ?? makeFreshState()
    // Claim the dispatch-tree root once: the first meta to use this state (a
    // top-level dispatch, or a fresh ctx.submitJob escape-hatch subtree) is the
    // root; every nested ctx.step inherits the same state → the same rootJobId.
    // ctx.askUser prefixes its correlation id with it so nested parks still
    // address the root. (See MetaSharedState.rootJobId.)
    sharedState.rootJobId ??= jobId

    // Host seam for resolving a sub-step's `input.references` handles
    // against this meta's asset context — the SAME context the parent dispatch
    // resolved its own references against: an agent loop stamps its runId into
    // spec.assetContextId (agent ledger), the chat path leaves it absent
    // (context_id === sessionId). Falling back to sessionId for an
    // agent-dispatched meta would resolve against the chat ledger, whose
    // identically-minted handles (image_1, …) can silently point at different
    // assets. Gated on bridge + a context id: without either (tests running
    // without a host bridge, host-only meta), sub-steps fall back to the
    // internal `ref.assets` channel as their only source.
    const bridge = this.agentAssetBridge
    const metaContextId = spec.assetContextId ?? spec.sessionId
    const resolveStepReferences =
      bridge && metaContextId
        ? (
            patternId: PatternId,
            input: unknown,
            coveredSlots: ReadonlySet<string>,
          ): readonly ResolvedAssetRef[] => {
            const child = this.registry.get(patternId)
            const refs = (input as { references?: Record<string, unknown> } | null)
              ?.references
            // Drop a need when the internal channel already covers its slot AND
            // the step's input does not reference it explicitly — exactly the
            // case where the resolver's omitted-required-slot default rule would
            // fire and merge an unrelated "latest of modality" ledger asset next
            // to the meta-supplied one. Explicit references keep resolving even
            // for covered slots (array-slot coexist semantics rely on that).
            const needs = (child?.assetNeeds ?? []).filter(
              (n) => !(coveredSlots.has(n.slot) && refs?.[n.slot] === undefined),
            )
            if (needs.length === 0) return []
            // Fail-closed — resolveForDispatch throws on unknown handle/slot;
            // the throw propagates out of ctx.step and fails the meta step
            // visibly (META_STEP_FAILED), never a silent zero-source dispatch.
            return bridge.resolveForDispatch({
              contextId: metaContextId,
              input,
              assetNeeds: needs,
            })
          }
        : undefined

    const ctx = buildMetaExecutionContext(
      {
        submitChild: <TIn2, TOut2>(
          s: JobSpec<TIn2>,
          ancestors: readonly PatternId[],
          ss: MetaSharedState,
          // Thread meta's controller signal as the parentSignal of every
          // `ctx.step` child so `cancelJob(metaJobId)` cascades down. `signal`
          // here closes over dispatchMeta's `signal` arg, which is the meta's
          // controller.signal (set up in _submitJobInternal).
        ) => this._submitJobInternal<TIn2, TOut2>(s, ancestors, ss, signal),
        ...(resolveStepReferences ? { resolveStepReferences } : {}),
        // Registry seam for the merge's single-cardinality dual-source guard:
        // the child's declared `assetNeeds` tell buildMetaExecutionContext which
        // slots are single vs array. Pure registry lookup, no bridge needed — the
        // guard only fires when both channels contribute, which requires
        // resolveStepReferences anyway.
        getAssetNeeds: (patternId: PatternId): readonly AssetNeed[] =>
          this.registry.get(patternId)?.assetNeeds ?? [],
        // Host HITL seam — `ctx.askUser` bridges to it (parks until the host
        // answers). Absent when the runtime was built without one → ctx.askUser
        // throws ASK_USER_NOT_SUPPORTED.
        ...(this.askUser ? { askUser: this.askUser } : {}),
      },
      meta.id,
      jobId,
      spec,
      signal,
      visited,
      sharedState,
      // Propagate the stepId namespace a parent meta stamped onto this child
      // meta's spec (e.g. `panel-0`). Top-level meta dispatch leaves
      // spec.stepIdNamespace undefined → ctx adds no prefix → behaviour
      // byte-identical to before. A nested meta picks up its parent's effective
      // step id and prefixes its own internal stepIds with it.
      spec.stepIdNamespace,
    )

    const output = await meta.compose(
      { input: spec.input },
      ctx,
    )
    return output as TOut
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
  private async dispatchAgent<TIn, TOut>(
    jobId: string,
    pattern: AgentPattern<TIn, TOut>,
    spec: JobSpec<TIn>,
    signal: AbortSignal,
    visited: Set<PatternId>,
  ): Promise<TOut> {
    // Capture the envelope for `getAgentEnvelope(jobId)` lookup.
    const envelopeStartTs = Date.now()
    let envelopeToolCount = 0
    if (!this.agentRunImpl) {
      throw new Error(
        `AGENT_RUN_IMPL_NOT_INJECTED: ${pattern.id} — registered AgentPattern but no InlineRuntimeInit.agentRunImpl`,
      )
    }

    // Count only agent ancestors (meta/atomic don't count against the agent
    // recursion budget).
    const agentDepth = countAgentAncestors(visited, this.registry)
    if (agentDepth > this.maxAgentDepth) {
      throw new Error(
        `AGENT_DEPTH_EXCEEDED: ${pattern.id} (agentDepth=${agentDepth}, max=${this.maxAgentDepth}). ` +
          `ancestor chain: ${[...visited].join(' → ')}`,
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

    const resolveCtx = this.resolveCtxProvider?.(spec) ?? {}

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
    // prompt-assembly layer to prune. Pattern authors who legitimately need
    // to expose a specific agent_ Pattern can opt-in via loop.toolPatternIds.
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
        throw new Error(
          `ASYNC_TOOL_PATTERN_ID_NOT_IN_TOOL_LIST: ${pattern.id} declared ` +
            `loop.asyncToolPatternIds containing ids not in loop.toolPatternIds: ` +
            `[${orphans.join(', ')}]. asyncToolPatternIds must be a subset of ` +
            `toolPatternIds (likely a typo or stale reference).`,
        )
      }
    }
    const effectiveToolPatternIds: readonly PatternId[] =
      isAsync && asyncAllowlist && asyncAllowlist.length > 0
        ? pattern.loop.toolPatternIds.filter((id) =>
            asyncAllowlist.includes(id),
          )
        : pattern.loop.toolPatternIds

    const staticExcludeIds = this.computeStaticAgentExcludes(
      pattern.id,
      effectiveToolPatternIds,
    )

    // Host tools are not assembled here. The runtime emits only the catalog
    // routing tools and forwards pattern.id to the AgentRunImpl seam; the host
    // decides which of its own tools that agent may see. Host-tool
    // visibility/policy is therefore not expressible in the Pattern spec (no
    // blocklist field, no passthrough list).
    // Inline core: the allowlist's always-load Patterns are laid out directly,
    // bypassing find_pattern.
    const { descriptors: inlineCore, inlineIds } = buildAgentInlineCore(
      effectiveToolPatternIds,
      this.registry,
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
      ...buildCatalogDescriptors(this.catalogOptions),
      ...(finishSpec ? [buildFinishDescriptor(finishSpec.inputs)] : []),
    ]

    // find_pattern search corpus. Scoped to effectiveToolPatternIds
    // ∖ staticExcludeIds so the subagent's catalog stays inside its declared
    // loop.toolPatternIds whitelist. Built per-dispatch (cheap — minisearch
    // indexes ~20 patterns in <1ms; registry doesn't mutate during loop).
    const subagentSearchIndex = new PatternSearchIndex(this.registry)
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
      throw new Error(
        `AGENT_SEED_PROMPT_MISSING: ${pattern.id} — AgentPattern's tool.inputs ` +
          `must include a non-empty string field 'prompt' (see @orchestral/core ` +
          `agentInputSchema). The parent LLM fills it during tool-call; runtime ` +
          `uses it as the subagent's single seed user message.`,
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
    const store = this.transcriptStore
    const runId = spec.resumeFromRunId ?? jobId
    const agentId = `${pattern.id}#${runId}`

    // Agent context = runId (per-agent handle namespace). The host
    // AgentAssetBridge records `passedIn` assets into this context (re-minting
    // child-local handles) and renders a write-once seed announcement. Opt-in
    // `inheritParentAssets` pulls from the dispatching chat/session context
    // (`spec.sessionId`); deeper nested-agent inherit is out of scope.
    const agentContextId = runId
    const seedAnnouncement =
      this.agentAssetBridge?.buildSeedAnnouncement({
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
        throw new Error(
          `RESUME_REQUIRES_TRANSCRIPT_STORE: spec.resumeFromRunId is set but ` +
            `InlineRuntime was constructed without a transcriptStore. Inject ` +
            `one (a durable store in production, InMemoryTranscriptStore for ` +
            `tests) before resume.`,
        )
      }
      const prior = await store.read(runId, agentId)
      // Refuse to resume when the target (runId, agentId) bucket is empty rather
      // than silently downgrade to a fresh dispatch. Stale jobIds, a mistaken
      // sessionId-vs-jobId mix-up,
      // or transcripts cleared out-of-band all surface as a hard error so
      // callers know they're not actually continuing prior work.
      if (prior.length === 0) {
        throw new Error(
          `RESUME_TARGET_NOT_FOUND: ${pattern.id} — no transcript rows under ` +
            `(runId=${spec.resumeFromRunId}, agentId=${agentId}). Either the ` +
            `previous dispatch never wrote to the transcriptStore (no agent ` +
            `loop steps completed) or resumeFromRunId points to a different ` +
            `Pattern's jobId.`,
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
              // An append failure must not block the agent loop; log a warning
              // and let the host decide whether to escalate it to fatal.
              console.warn(
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
      throw new Error(
        `AGENT_OUTPUTS_MISSING: ${pattern.id} — registered AgentPattern lost its outputs schema`,
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
        void this.fanoutJobEvent(jobId, (job) => ({
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
      const result = await this.agentRunImpl.run({
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
              if (!this.agentAssetBridge) {
                throw Object.assign(
                  new Error(
                    `AGENT_ASSET_BRIDGE_MISSING: ${pattern.id} finish carries ` +
                      `deliverable handles but no AgentAssetBridge is injected.`,
                  ),
                  { code: 'AGENT_ASSET_BRIDGE_MISSING' },
                )
              }
              try {
                const refs = this.agentAssetBridge.resolveHandles({
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
              router: this.router,
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
            const target = resolveDispatchTarget(this.registry, parsed.data, 'agent-loop')
            if (isDispatchError(target)) {
              // Pattern lookup or input zod validation failed — return as
              // tool_result content so LLM self-corrects on next turn.
              return target
            }
            const fullId = target.pattern.id
            // Runtime ancestor check. A two-stage catalog has no per-Pattern
            // descriptors to strip up-front, so the cycle check fires here on
            // the resolved pattern_id.
            if (visited.has(fullId)) {
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
            const inAllowlist = effectiveToolPatternIds.includes(fullId)
            if (!inAllowlist) {
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
            const blockedByPrefix = DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes.some(
              (prefix) => fullId.startsWith(prefix),
            )
            const blockedById = DEFAULT_SUBAGENT_BLOCKLIST.patternIds.includes(fullId)
            if (blockedByPrefix || blockedById) {
              return {
                code: 'SUBAGENT_BLOCKED',
                pattern_id: fullId,
                caller_pattern_id: pattern.id,
                reason: blockedByPrefix ? ('prefix' as const) : ('id' as const),
                message:
                  `${fullId} matched DEFAULT_SUBAGENT_BLOCKLIST. ` +
                  `Pattern authors should NOT list blocklist-prefixed ids in loop.toolPatternIds.`,
                hint: 'Choose a different pattern_id; agent-prefixed ids cannot be recursed into.',
              }
            }
            // Inner resolution — resolve the child's `input.references`
            // handles against THIS agent's context ledger before dispatch.
            // resolveForDispatch is fail-closed (throws on any resolution
            // failure); a broad catch maps it to an ASSET_RESOLUTION_FAILED
            // tool-result so the loop self-corrects rather than dying.
            let childAssets: readonly ResolvedAssetRef[] = []
            if (this.agentAssetBridge && (target.pattern.assetNeeds?.length ?? 0) > 0) {
              try {
                childAssets = this.agentAssetBridge.resolveForDispatch({
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
            const child = await this._submitJobInternal({
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
            if (child.status === 'error') {
              // Structured tool_result so the LLM can read the inner failure
              // and either retry with different input or pick another Pattern.
              // Throwing would terminate the agent loop.
              //
              // Only the CACHED-error path lands here (the child resolved to a
              // stored errored job, so its JobError.producedAssets is available
              // to echo). The fresh-throw nested case (a sub-agent throwing
              // mid-loop) propagates out through agent-run-impl's rejection
              // handler and does NOT yet carry producedAssets — that needs a
              // protocol-level error-shape change (out of scope here).
              // invalid-input (HTTP 4xx, except transient 408/429) means the
              // subagent's parameters were wrong for the resolved model —
              // schema unchanged, fix and retry. Everything else reads as
              // provider/transient trouble. Mirrors the chat-turn JOB_FAILED
              // classification; the subagent path carries no next_input_schema
              // (its find_pattern runs in degraded base-schema mode).
              const httpStatus = (
                child.error?.details as { httpStatus?: number } | undefined
              )?.httpStatus
              const errorClass =
                httpStatus != null &&
                httpStatus >= 400 &&
                httpStatus < 500 &&
                httpStatus !== 408 &&
                httpStatus !== 429
                  ? 'invalid-input'
                  : 'other'
              return {
                code: 'SUBAGENT_TOOL_FAILED',
                pattern_id: fullId,
                error_class: errorClass,
                ...(child.error?.code ? { inner_code: child.error.code } : {}),
                ...(child.error?.producedAssets?.length ? { produced_assets: child.error.producedAssets } : {}),
                message: child.error?.message ?? 'inner pattern dispatch failed',
                hint:
                  errorClass === 'invalid-input'
                    ? 'The provider rejected these parameters (HTTP 4xx). Fix or drop the offending fields named in message, then dispatch again.'
                    : 'Try different input, or pick a different pattern_id via find_pattern.',
              }
            }
            // Envelope: count each successful tool dispatch.
            envelopeToolCount++
            // Record the tool-result kind into the transcript so resume can
            // replay tool outputs alongside assistant text. Skipped if no store
            // was injected. Failure to append is logged but never blocks the
            // agent loop (the in-flight LLM call is more important than the log).
            if (store) {
              const toolResultMsg: TranscriptMessage = {
                seq: transcriptSeq++,
                ts: Date.now(),
                kind: 'tool-result',
                raw: { name, output: child.output, pattern_id: fullId },
              }
              void store
                .append(runId, agentId, toolResultMsg)
                .catch((err: unknown) => {
                  console.warn(
                    `[dispatchAgent] transcriptStore.append (tool-result) failed for ${runId}/${agentId} seq=${toolResultMsg.seq}:`,
                    err,
                  )
                })
            }
            // Record the child's produced assets into this agent context so
            // later references in the loop (or inheriting children) resolve.
            // recordOutput returns the model-facing output with handles stamped
            // (+ origin/from lineage); we forward THAT to the loop — not the raw
            // child.output (assetId+url, no handle), which the downstream D3
            // projection would drop for lacking a handle. Mirrors the chat
            // path's stampSessionHandles + attachProducedLineage on job.output.
            const stamped = this.agentAssetBridge?.recordOutput({
              contextId: agentContextId,
              ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
              toolCallId: callId ?? fullId,
              patternId: fullId,
              resolvedInputs: childAssets,
              output: child.output,
            })
            return stamped ?? child.output
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
      //     no valid finish arrived (replaces the old bare-{text} sniffing).
      const setErroredEnvelope = (errorMessage: string): void => {
        this.agentEnvelopes.set(jobId, {
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

      this.agentEnvelopes.set(jobId, {
        patternId: pattern.id,
        text: result.text,
        status: 'completed',
        totalToolUseCount: envelopeToolCount,
        totalDurationMs: Date.now() - envelopeStartTs,
        ...(result.usage ? { usage: result.usage } : {}),
        // Emit both runId and transcriptId so the host can call
        // `transcriptStore.read(runId, transcriptId)` to fetch full history.
        // The errored path (above) already does this; success was missing
        // runId, which left getAgentEnvelope consumers unable to query.
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
          this.agentEnvelopes.set(jobId, {
            patternId: pattern.id,
            text: '',
            status: 'completed',
            totalToolUseCount: envelopeToolCount,
            totalDurationMs: Date.now() - envelopeStartTs,
            ...(store ? { runId, transcriptId: agentId } : {}),
          })
          return parsed
        } catch (salvageErr) {
          this.agentEnvelopes.set(jobId, {
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
        this.agentAssetBridge?.recordedAssetIds(agentContextId) ?? []
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
   */
  private computeStaticAgentExcludes(
    selfId: PatternId,
    toolPatternIds: readonly PatternId[] | undefined,
  ): PatternId[] {
    const out: PatternId[] = [selfId]
    // Expand idPrefixes into concrete ids; iterate registry.values().
    for (const p of this.registry.values()) {
      if (p.id === selfId) continue // self already in out
      const blockedByPrefix = DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes.some(
        (prefix) => p.id.startsWith(prefix),
      )
      const blockedById = DEFAULT_SUBAGENT_BLOCKLIST.patternIds.includes(p.id)
      if (blockedByPrefix || blockedById) {
        // Pattern author opt-in via loop.toolPatternIds wins over default
        // blocklist — keep id out of the static exclude list so the
        // catalog builder's `includeOnly` filter can include it.
        if (toolPatternIds?.includes(p.id)) continue
        out.push(p.id)
      }
    }
    return out
  }

  /**
   * Pick the first registered alternative whose appliesWhen matches.
   * Synchronous; no IO beyond Router.checkSatisfiable.
   */
  private pickAlternative<I, O>(
    atomic: AtomicPattern<I, O>,
    ctx: ResolveContext,
    requiredTags: readonly ModelTag[],
    requestedSemantics: readonly Semantics[],
  ): Alternative<I, O> | null {
    const alternatives = this.registry.getEntry(atomic.id)?.alternatives ?? []
    if (alternatives.length === 0) return null
    for (const alt of alternatives) {
      if (
        this.appliesWhen(
          alt.appliesWhen,
          ctx,
          atomic.id as Capability,
          requiredTags,
          requestedSemantics,
        )
      ) {
        return alt as Alternative<I, O>
      }
    }
    return null
  }

  private appliesWhen(
    cond: AlternativeAppliesWhen,
    ctx: ResolveContext,
    cap: Capability,
    fallbackTags: readonly ModelTag[],
    requestedSemantics: readonly Semantics[],
  ): boolean {
    switch (cond.kind) {
      case 'always':
        return true
      case 'capability-unavailable': {
        const tags = cond.requiredTags ?? fallbackTags
        return !this.router.checkSatisfiable(cap, tags, ctx).ok
      }
      case 'preserves-required':
        return cond.semantics.some((s) => requestedSemantics.includes(s))
      case 'budget-below':
        // BudgetGuard not wired yet; never triggers.
        return false
    }
  }

  private async runAlternative<TIn, TOut>(
    jobId: string,
    alt: Alternative<TIn, TOut>,
    spec: JobSpec<TIn>,
    signal: AbortSignal,
    visited: Set<PatternId>,
    depth: number,
    // Forward the parent ctx into the redirect dispatch so the alternative
    // target's atomic fork seed matches the original dispatch.
    parentCtx?: DispatchContext,
  ): Promise<TOut> {
    const targetId = alt.via.patternId
    if (visited.has(targetId)) {
      throw new Error(`CIRCULAR_ALTERNATIVE: ${targetId} already visited`)
    }
    const target = this.registry.getEntry(targetId)?.pattern
    if (!target) {
      throw new Error(`ALTERNATIVE_PATTERN_NOT_REGISTERED: ${targetId}`)
    }
    // Surface the degradation before the redirect dispatches — without this
    // event a subscriber cannot tell a degraded completion from a primary
    // one, and the Alternative's declared losses/qualityDelta metadata would
    // be evaluated and then thrown away.
    const snapshot = await this.store.get(jobId)
    if (snapshot) {
      this.fanout(jobId, {
        type: 'job:alternative-selected',
        job: snapshot,
        alternativeId: alt.id,
        description: alt.description,
        targetPatternId: targetId,
        ...(alt.preserves ? { preserves: alt.preserves } : {}),
        ...(alt.losses ? { losses: alt.losses } : {}),
        ...(alt.qualityDelta !== undefined ? { qualityDelta: alt.qualityDelta } : {}),
      })
    }
    const childInput = alt.via.mapInput(spec.input)
    const childSpec: JobSpec = {
      patternId: targetId,
      input: childInput,
      // Propagate the resolved assets into the redirect target so the
      // alternative dispatch sees the same source assets the parent resolved.
      ...(spec.assets ? { assets: spec.assets } : {}),
      // Ambient host context rides along too: the degraded path must run with
      // the same UI-default providerOptions and asset-resolution context the
      // primary would have received, or generation parameters silently change.
      ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
      ...(spec.assetContextId ? { assetContextId: spec.assetContextId } : {}),
      sessionId: spec.sessionId,
    }
    const nextVisited = new Set(visited).add(targetId)
    // Alternative target always invoked via its primary path. To direct an
    // alternative to a specific sub-mode, the author shapes it via
    // the child Pattern's input.providerOptions / input.references. Reuses the
    // original jobId so any CallEvents the alternative model fires fan out
    // under the same Job.
    const childOutput = await this.dispatch(
      jobId,
      target,
      childSpec,
      signal,
      nextVisited,
      depth + 1,
      undefined,
      parentCtx,
    )
    return alt.via.mapOutput(childOutput) as TOut
  }

  // ── Runtime interface ────────────────────────────────────────────────────

  async pollJob<TIn = unknown, TOut = unknown>(
    jobId: string,
  ): Promise<Job<TIn, TOut>> {
    const job = await this.store.get(jobId)
    if (!job) throw new Error(`JOB_NOT_FOUND: ${jobId}`)
    return job as Job<TIn, TOut>
  }

  /**
   * Look up the envelope captured during a completed (or errored) AgentPattern
   * dispatch. Returns `undefined` for non-agent
   * jobIds, jobs that haven't settled yet, or after the entry was cleared
   * by `cancelJob` / explicit `disposeAgentEnvelope`.
   *
   * Typical usage: after observing `job:done` / `job:error` for a job whose
   * pattern is `kind: 'agent'`, call `runtime.getAgentEnvelope(job.id)` to
   * pull totalToolUseCount / totalDurationMs / usage / transcriptId for
   * the parent host's UI or telemetry.
   */
  getAgentEnvelope(jobId: string): AgentDispatchEnvelope | undefined {
    return this.agentEnvelopes.get(jobId)
  }

  /**
   * Drop the cached envelope for `jobId`. The Map grows linearly with agent
   * dispatches, so hosts running long-lived sessions should evict either
   * after reading the envelope or on a periodic sweep.
   */
  disposeAgentEnvelope(jobId: string): void {
    this.agentEnvelopes.delete(jobId)
  }

  async cancelJob(jobId: string, reason?: string): Promise<void> {
    const existing = await this.store.get(jobId)
    if (!existing) throw new Error(`JOB_NOT_FOUND: ${jobId}`)
    if (
      existing.status === 'done' ||
      existing.status === 'error' ||
      existing.status === 'cancelled' ||
      existing.status === 'stale'
    ) {
      throw new Error(`JOB_ALREADY_TERMINAL: ${jobId} is ${existing.status}`)
    }
    const controller = this.controllers.get(jobId)
    if (controller) controller.abort()

    // The abort above can let the job's own completion path land a terminal
    // status before the cancel write. conditionalUpdate writes 'cancelled' only
    // while the job is still queued/running, so a settled result is never
    // overwritten and 'job:cancelled' never fans out for work that finished —
    // this closes the check-then-act race atomically at the store level.
    //
    // Cancelled is its own status, not piggy-backed on 'error' with
    // error.code === 'CANCELLED'. The idempotency dedup rule is unchanged
    // (`findByIdempotencyKey` returns hits only for queued/running/done) —
    // cancelled jobs are still re-runnable.
    void reason // cancellation reason goes to the event below, not the row
    for (const nonTerminal of ['queued', 'running'] as const) {
      const wrote = await this.store.conditionalUpdate(
        jobId,
        { status: 'cancelled', error: null, updatedAt: Date.now() },
        nonTerminal,
      )
      if (wrote) {
        // Clear any sidecar envelope the agent dispatch may have captured, then
        // fan out the terminal event from the freshly written row. (The JSDoc on
        // `getAgentEnvelope` promises cancelJob clears the entry — keep that.)
        this.agentEnvelopes.delete(jobId)
        const next = await this.store.get(jobId)
        if (next) this.fanout(jobId, { type: 'job:cancelled', job: next })
        return
      }
    }
    // Both guards returned false — the job settled inside the cancel window.
    // Its own completion path owns the terminal event; just drop the envelope.
    this.agentEnvelopes.delete(jobId)
  }

  subscribe(jobId: string, cb: (ev: JobEvent) => void): Unsubscribe {
    let set = this.subscribers.get(jobId)
    if (!set) {
      set = new Set()
      this.subscribers.set(jobId, set)
    }
    set.add(cb)
    return () => {
      const current = this.subscribers.get(jobId)
      if (!current) return
      current.delete(cb)
      if (current.size === 0) this.subscribers.delete(jobId)
    }
  }

  /**
   * In-process runtime: lost in-flight work cannot be resumed. Every
   * queued/running row is marked terminal 'stale' (emitting job:stale) so
   * the store is consistent after a crash — reconcile() here is abandonment
   * with bookkeeping, not re-attachment. See Runtime.reconcile for the
   * substrate contract.
   */
  async reconcile(): Promise<readonly Job[]> {
    const stuck = await this.store.query({
      status: ['queued', 'running'] as readonly JobStatus[],
    })
    const updated: Job[] = []
    for (const job of stuck) {
      try {
        await this.store.update(job.id, { status: 'stale', updatedAt: Date.now() })
        const next = await this.store.get(job.id)
        if (next) {
          updated.push(next)
          this.fanout(job.id, { type: 'job:stale', job: next })
        }
      } catch (e) {
        console.warn(`[runtime] reconcile failed for ${job.id}:`, e)
      }
    }
    return updated
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Build the CallEvents bridge handed to `ModelCapability.call()`. The
   * call adapter fires these inside its provider SDK callbacks; we
   * translate them into Job events under the supplied jobId.
   *
   * The job snapshot used in the event is fetched lazily on each callback
   * via `store.get` — progress events don't carry strict freshness
   * guarantees and we'd rather pay one read than risk a stale closure
   * shipping the wrong status (e.g. a `cancelled` slipping through).
   */
  private buildCallEvents(jobId: string): CallEvents {
    return {
      onProgress: (e) => {
        const raw = typeof e.fraction === 'number' ? e.fraction : 0
        const fraction = Math.max(0, Math.min(1, raw))
        void this.fanoutJobEvent(jobId, (job) => ({
          type: 'job:progress',
          job,
          fraction,
          ...(e.message ? { message: e.message } : {}),
        }))
      },
      onArtifact: (artifact) => {
        void this.fanoutJobEvent(jobId, (job) => ({
          type: 'job:artifact',
          job,
          artifact,
        }))
      },
    }
  }

  /**
   * Fan out an event for the latest Job snapshot from the store. Used by
   * CallEvents callbacks where we need a current Job shape but the
   * callsite is synchronous (fire-and-forget). Swallows store-read
   * failures since these events are advisory only.
   */
  private async fanoutJobEvent(
    jobId: string,
    build: (job: Job) => JobEvent,
  ): Promise<void> {
    try {
      const job = await this.store.get(jobId)
      if (!job) return
      this.fanout(jobId, build(job))
    } catch (e) {
      console.warn(`[runtime] fanoutJobEvent failed for ${jobId}:`, e)
    }
  }

  private async markErrored(id: string, err: JobError): Promise<void> {
    await this.store.update(id, {
      status: 'error',
      error: err,
      updatedAt: Date.now(),
    })
    const final = await this.store.get(id)
    if (final) this.fanout(id, { type: 'job:failed', job: final })
  }

  private fanout(jobId: string, event: JobEvent): void {
    const set = this.subscribers.get(jobId)
    if (!set || set.size === 0) return
    for (const cb of [...set]) {
      try { cb(event) }
      catch (e) { console.error('[runtime] subscriber threw:', e) }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normaliseError(err: unknown, defaultCode?: string): JobError {
  if (err instanceof Error) {
    const code =
      (err as { code?: string }).code ?? defaultCode ?? 'DISPATCH_EXECUTE_FAILED'
    // A dispatchAgent whole-run failure throws an Error carrying the assetIds
    // produced before it failed; preserve them onto the JobError so the parent
    // can reference the partial output in its failure tool-result.
    const produced = (err as { producedAssets?: readonly string[] }).producedAssets
    // Structured failure facts stamped upstream (the host gateway attaches
    // httpStatus from the wire; the dispatch loop stamps failedModel; the
    // capability router attaches `diagnostic` to ModelExcludedError with the
    // requiredTags and surviving candidates behind an unhonoured model pin).
    // Lifted into details so hosts classify invalid-input (4xx) vs transient,
    // derive retry exclusion sets, and explain a routing miss — all without
    // regexing the message.
    const httpStatus = (err as { httpStatus?: number }).httpStatus
    const failedModel = (err as { failedModel?: string }).failedModel
    const diagnostic = (err as { diagnostic?: unknown }).diagnostic
    const details = {
      ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
      ...(typeof failedModel === 'string' ? { failedModel } : {}),
      ...(typeof diagnostic === 'object' && diagnostic !== null ? { diagnostic } : {}),
    }
    return {
      code,
      message: err.message,
      cause: err,
      ...(Object.keys(details).length ? { details } : {}),
      ...(produced?.length ? { producedAssets: produced } : {}),
    }
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return {
        code: defaultCode ?? 'UNKNOWN',
        message: JSON.stringify(err),
        details: err,
      }
    } catch {
      return {
        code: defaultCode ?? 'UNKNOWN',
        message: '[unserialisable error]',
      }
    }
  }
  return { code: defaultCode ?? 'UNKNOWN', message: String(err) }
}

/**
 * Sentinel thrown by the afterDispatch loop so the outer catch can route
 * its `cause` through `normaliseError` with the `MIDDLEWARE_AFTER_FAILED`
 * override code — keeps the markErrored / onError-chain path centralised.
 */
class MiddlewareAfterFailure extends Error {
  constructor(public readonly innerCause: unknown) {
    super('MIDDLEWARE_AFTER_FAILED')
  }
}

// Re-export the historical class name so callers that imported
// `InlineRuntimeAdapter` keep working through this transition.
export { InlineRuntime as InlineRuntimeAdapter }

// ExecutionContext is constructed by dispatchMeta via
// `buildMetaExecutionContext` (see `./meta-execution-context.ts`). Carries
// submitJob + step + compute + abort signal. Hosts that need it for other
// paths (e.g. driving an atomic call adapter from outside the runtime)
// wrap InlineRuntime themselves.
export type { ExecutionContext }
