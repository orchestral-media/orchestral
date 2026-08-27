// In-process Runtime implementation.
//
// This file owns the job lifecycle — submit, dedup, the middleware chain,
// atomic and meta dispatch, cancellation, subscription fan-out. The parts big
// enough to reason about on their own sit next to it and take what they need
// as a deps object rather than a back-reference to the runtime:
//
//  • ./agent-dispatch  — agent-kind dispatch and its recursion guards
//  • ./alternatives    — selecting and running a declared fallback path
//  • ./errors          — normalising anything thrown into one JobError shape
//
// Design highlights:
//  • The runtime resolves a ModelCapability via the Router and invokes
//    `modelCap.call(effectiveInput, ctx)` — primary path only.
//  • A model the dispatch gives up on is announced as `job:model-fallback`
//    (that hop's own error + attempt count) and accumulated into
//    `ResolveContext.excludeModel`, so the next `resolve` walks to the next
//    candidate. Retrying the SAME model first is separate and opt-in
//    (`InlineRuntimeInit.transientRetry`) — the two budgets never mix.
//  • Every atomic and meta output is checked against `pattern.outputs` at the
//    dispatch exit and fails the job with OUTPUT_SCHEMA_MISMATCH when it does
//    not conform; `InlineRuntimeInit.outputValidation: 'off'` is the opt-out.
//  • Nothing here writes to the host console — what belongs to a job is a
//    JobEvent; what has no job to ride on (a host callback that threw) goes
//    to `InlineRuntimeInit.logger`.
//  • Cross-Pattern recovery is declarative via `Pattern.alternatives[*]`
//    evaluated in the satisfiability phase — opt-in, off by default
//    (`InlineRuntimeInit.alternatives`).
//  • Idempotency uses a canonical JSON hash (drops Date / Map / Buffer hazards).
//  • Parent AbortSignal propagates into every child `submitJob`.
//  • Alternative chain carries a `visited` Set so A→B→A loops fail loudly.

import { randomUUID } from 'node:crypto'

import type {
  AgentDispatchEnvelope,
  AgentPattern,
  AskUserHandler,
  AssetNeed,
  AtomicPattern,
  CallEvents,
  Capability,
  CapabilityRouter,
  DiagnosticsLogger,
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
  PatternSearch,
  ResolveContext,
  ResolveCtxProvider,
  ResolvedAssetRef,
  RetryPolicy,
  Runtime,
  TranscriptStore,
  Unsubscribe,
  DispatchResult,
} from '@orchestral/core'
import {
  applicableAlternatives,
  assertSupportedModelSpecVersion,
  consoleDiagnosticsLogger,
  NoModelForCapabilityError,
  pickAlternative,
  readRequiresSemantics,
} from '@orchestral/core'
import type { BuildCatalogDescriptorsOptions } from '@orchestral/core'

import { deriveIdempotencyKey } from './idempotency'
import { forkExecutionContext } from './fork-context'
import type {
  AgentRunImpl,
} from './agent-run'
import {
  abortableSleep,
  buildMetaExecutionContext,
  makeFreshState,
  nextRetryDelayMs,
  type MetaSharedState,
} from './meta-execution-context'
import { cancelledError, MiddlewareAfterFailure, normaliseError } from './errors'
import {
  type AgentAssetBridge,
  type AgentDispatchDeps,
  buildAgentInlineCore,
  countAgentAncestors,
  dispatchAgent,
} from './agent-dispatch'
import { AlternativesNotEnabledError, runAlternative } from './alternatives'

/**
 * Cap on retained agent envelopes. `getAgentEnvelope` is a read-after-settle
 * lookup, so only recent dispatches are ever asked for; keeping the map
 * bounded means a host that forgets `disposeAgentEnvelope` leaks nothing
 * worse than this many envelopes.
 */
const MAX_AGENT_ENVELOPES = 64

/**
 * The produced-media array off a step's output envelope, when it has one.
 * Read structurally rather than by pattern kind: every first-party output that
 * carries media uses `assets`, and a third-party Pattern that follows the same
 * envelope gets the same treatment for free.
 */
function stepAssets(
  output: unknown,
): readonly { assetId: string; modality: string; url?: string }[] | undefined {
  const assets = (output as { assets?: unknown } | null | undefined)?.assets
  if (!Array.isArray(assets) || assets.length === 0) return undefined
  const usable = assets.filter(
    (a): a is { assetId: string; modality: string; url?: string } =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as { assetId?: unknown }).assetId === 'string' &&
      typeof (a as { modality?: unknown }).modality === 'string',
  )
  return usable.length > 0 ? usable : undefined
}

/**
 * Event types after which no further event can fan out for that job. Used to
 * release the job's subscriber set — see `fanout`.
 */
const TERMINAL_EVENTS: ReadonlySet<JobEvent['type']> = new Set([
  'job:completed',
  'job:failed',
  'job:cancelled',
  'job:stale',
])

/** Default cap on `Pattern.alternatives` recursion depth. */
const DEFAULT_MAX_ALTERNATIVE_DEPTH = 4

/**
 * Automatic `Pattern.alternatives` redirects are off unless the host asks for
 * them. See `InlineRuntimeInit.alternatives` for the reasoning.
 * DESIGN: alternatives-default-off
 */
const DEFAULT_ALTERNATIVES_MODE = 'off' as const

/**
 * Default depth of the model fallback walk — how many further candidates a
 * dispatch resolves after giving up on the first. `ResolveContext.fallbackDepth`
 * overrides it per dispatch.
 */
const DEFAULT_FALLBACK_DEPTH = 3

/**
 * Outputs are checked against their Pattern's schema unless the host opts
 * out. See `InlineRuntimeInit.outputValidation` for the reasoning.
 */
const DEFAULT_OUTPUT_VALIDATION = 'strict' as const

/**
 * Default cap on agent/meta nesting depth.
 *
 * 2 = chat-turn (the top-level host orchestration entry, depth=0) → 1 subagent
 * (depth=1) → blocked at depth=2. Together with the default blocklist (which
 * excludes `agent_*`-prefixed Patterns from subagent catalogs), this gives
 * defence-in-depth against recursion.
 *
 * Raising this alone does NOT open a recursive path. `agent_`-prefixed
 * Patterns are refused by the default blocklist at both the catalog and the
 * dispatch guard, and listing one in `loop.toolPatternIds` does not lift that
 * — an allowlist narrows what an agent may reach, it never widens it. Opening
 * director → cinematographer → camera-operator means supplying a blocklist
 * that does not carry the `agent_` prefix, which no seam injects today: the
 * recursive path is closed, deliberately, until someone argues for that seam.
 */
const DEFAULT_MAX_AGENT_DEPTH = 2


/**
 * What the runtime knows about the failure it is asking the host to classify.
 * Passed to `TransientRetryConfig.isTransient` so one predicate can answer
 * differently for a cheap image call and an expensive video one without the
 * host constructing a second runtime.
 */
export interface TransientFailureInfo {
  /** The capability being dispatched. */
  readonly capability: Capability
  /** The model whose `call` threw, as `provider:modelId`. */
  readonly model: string
  /** 1-based attempt against THIS model — `1` is the original call. */
  readonly attempt: number
}

/**
 * Opt-in same-model retry (`InlineRuntimeInit.transientRetry`). Both fields
 * are required: a config missing either would be a field nobody reads, and
 * this package does not ship those.
 */
export interface TransientRetryConfig {
  /**
   * Is this failure worth calling the SAME model again for? The library never
   * answers this itself — see `InlineRuntimeInit.transientRetry` for why the
   * judgement is the host's.
   *
   * Called once per failure, before any backoff. Return `false` for anything
   * you cannot classify; a predicate that throws is logged and read as
   * `false`, so a bug in here can never displace the provider error it was
   * asked about.
   * DESIGN: is-transient-throw-is-false
   */
  isTransient: (error: unknown, info: TransientFailureInfo) => boolean
  /**
   * How many attempts against one model and how long to wait between them.
   * Core's `RetryPolicy`, the same shape `ctx.step` / `ctx.compute` take, so
   * `maxAttempts` counts TOTAL calls (`3` = the original plus two retries) and
   * `{ kind: 'none' }` means the config is wired but inert.
   */
  policy: RetryPolicy
}

/**
 * Run the host's transience predicate without letting it displace the provider
 * error it was asked about. A predicate that throws (reading `err.response.status`
 * off a string, say) is a host bug, and surfacing THAT instead of the real
 * failure is the same masking the dispatch loop's lastErr guard exists to
 * prevent — so it is reported on the host's diagnostics logger and read as
 * "not transient", which is the fail-closed answer.
 */
function classifyTransient(
  config: TransientRetryConfig,
  logger: DiagnosticsLogger,
  error: unknown,
  info: TransientFailureInfo,
): boolean {
  try {
    return config.isTransient(error, info) === true
  } catch (predicateError) {
    // A host-callback failure has no event to ride on; the provider failure
    // it was asked about is what `job:model-fallback` carries.
    logger.error(
      `[inline-runtime] transientRetry.isTransient threw for ${info.model} ` +
        `(cap=${info.capability}); treating the failure as non-transient:`,
      predicateError,
    )
    return false
  }
}

// `ResolveCtxProvider` is @orchestral/core's (runtime.ts): the same provider
// `InlineRuntimeInit` takes below is what @orchestral/plan's `preflightPlan`
// takes, so the report names the model the run would pick. Re-exported here so
// this package's barrel still carries it.
export type { ResolveCtxProvider }


export interface InlineRuntimeInit {
  store: JobStore
  registry: PatternRegistry
  router: CapabilityRouter
  resolveCtxProvider?: ResolveCtxProvider
  /**
   * Fires synchronously inside `submitJob` after the runtime mints a jobId
   * and inserts the queued row, BEFORE dispatch. Lets the host correlate
   * its own request id to the runtime jobId so it can call cancelJob
   * mid-flight. Exceptions are reported on `logger` and otherwise swallowed
   * (observational only).
   */
  onJobCreated?: (jobId: string, spec: JobSpec) => void
  /**
   * Whether a failed primary path may be redirected through the parent
   * Pattern's declared `alternatives`. Defaults to `'off'`.
   *
   * `'off'` — the primary path is the only path. When the capability cannot
   * be served AND a declared alternative's `appliesWhen` matches, the job
   * fails with an `ALTERNATIVES_NOT_ENABLED` JobError whose
   * `details.diagnostic` lists every applicable path (id / description /
   * target patternId) plus how to turn redirects on, so the caller — or an
   * LLM reading the failed tool result — can choose one deliberately. With no
   * applicable alternative the failure is the plain router error, unchanged.
   *
   * `'auto'` — the runtime takes the first alternative whose `appliesWhen`
   * matches, announcing the swap with `job:alternative-selected` before the
   * redirect dispatches.
   *
   * Off by default because substituting a semantically different path is a
   * product decision, not a runtime one: a caller who asked for an
   * identity-preserving edit and silently received a re-render from a caption
   * got a different answer, not a retry. Failing loudly with the paths named
   * keeps that choice with the host.
   * DESIGN: alternatives-off-is-a-product-decision
   */
  alternatives?: 'auto' | 'off'
  /**
   * Cap on `Pattern.alternatives` recursion depth. Defaults to 4. Tune
   * down for tighter latency budgets; tune up only if you genuinely have
   * deep fallback chains (rare). Only reachable with `alternatives: 'auto'`.
   */
  maxAlternativeDepth?: number
  /**
   * Default depth of the model fallback walk: how many FURTHER candidates a
   * dispatch may resolve after giving up on the first. Defaults to 3.
   * `ResolveContext.fallbackDepth` overrides it per dispatch — a host with a
   * configured chain sets it to `rankedModels.length - 1` so the whole order
   * is walked and no further.
   *
   * Two neighbours it is deliberately not: `maxAlternativeDepth` bounds
   * cross-Pattern `Alternative` redirects (a different Pattern), while this
   * walks models within one Pattern; `transientRetry` re-calls a single model
   * and never advances this walk.
   */
  fallbackDepth?: number
  /**
   * Opt-in same-model retry. Absent — the default — a `model.call` failure is
   * final for that model: it goes into `excludeModel` and the dispatch walks
   * to the next candidate, exactly as it did before this option existed.
   *
   * Wired, the runtime asks `isTransient` about each failure and, while
   * `policy` has attempts left, calls the SAME model again after the policy's
   * backoff. Only a `false` answer or an exhausted policy excludes the model
   * and lets the fallback walk advance.
   *
   * The library never guesses transience, because guessing wrong spends real
   * money in both directions: a 429 read as fatal drops the dispatch onto a
   * pricier or worse candidate, and a content rejection read as a blip pays
   * for the same refusal three times. Only host code holding the provider
   * SDK's own error shapes can tell those apart, so there is no built-in
   * classifier to fall back on — without this field nothing is transient.
   *
   * Per runtime instance, like `alternatives`. `isTransient` receives the
   * capability and model, so one instance still covers surfaces that want
   * different answers.
   * DESIGN: no-built-in-transience-classifier
   */
  transientRetry?: TransientRetryConfig
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
   * Whether an atomic or meta output is checked against `pattern.outputs`
   * before the dispatch returns it. Defaults to `'strict'`.
   *
   * `'strict'` — `pattern.outputs.safeParse(output)` runs at the dispatch exit
   * of every atomic and meta dispatch (the agent path validates through its
   * finish tool already). An output the schema rejects fails the job with an
   * `OUTPUT_SCHEMA_MISMATCH` JobError whose `details` carries the pattern id
   * and kind, the zod issues (path + message), and `rawOutput` — the call was
   * paid for, so a host can still salvage what came back. A conforming output
   * is returned exactly as the adapter produced it, never zod's parsed copy.
   *
   * `'off'` — no check; whatever the adapter or compose returned flows through.
   *
   * Strict by default because the schema is the contract everything
   * downstream reads against: a parent meta's `ctx.step` result, the
   * model-facing projection, a host reading `job.output`. An adapter that
   * returns `{ text }` for a pattern whose schema promises `assets[]`, or a
   * meta that forgets `cost`, should fail at the seam that can name the
   * pattern and the field, not three steps later as an `undefined` access
   * with no record of which dispatch produced it. `'off'` is for a migration
   * window — adapters the host does not control and is bringing into
   * conformance one at a time — and a host on that path can still run the
   * check itself from `afterDispatch` middleware, which sees every output.
   *
   * There is no `'warn'`. A mismatch belongs to a job, and what belongs to a
   * job is a JobEvent, not a log line (see `logger`); a mode that logged and
   * let the output through would be `'off'` with a line attached, read by
   * nobody the output is about to break.
   */
  outputValidation?: 'strict' | 'off'
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
  /**
   * Host seam — what answers a `find_pattern` call from an agent loop. The
   * runtime ships no retrieval and takes no search dependency: which algorithm
   * ranks a free-form query is a product decision, the same kind of decision
   * `agentRunImpl` and `ModelCapability.call` already leave to the host. Wire
   * the first-party BM25 one with `createPatternSearch(registry, { router })`
   * from `@orchestral/discovery`, or implement `PatternSearch` over your own
   * embeddings / hosted search.
   *
   * Absent — the default — an agent loop's catalog contains no `find_pattern`
   * tool at all. The always-load inline core (a static catalog; no search
   * involved) and `dispatch_pattern` are untouched, so an agent whose
   * `loop.toolPatternIds` are all always-load runs exactly as before. An agent
   * that was meant to DISCOVER Patterns will not: a tool whose only possible
   * answer is "no retrieval wired" spends prompt-prefix bytes and buys a
   * round-trip the model cannot complete, so it is not advertised.
   *
   * Satisfiability filtering is not applied for you. An implementation that
   * wants unroutable atomics dropped takes the same `CapabilityRouter` this
   * runtime got — `createPatternSearch(registry, { router })` does exactly
   * that, and omitting it means the model may be shown a Pattern the dispatch
   * will then fail to route.
   */
  patternSearch?: PatternSearch
  /**
   * Where diagnostics that have no JobEvent go. Anything that belongs to a
   * job — a model the fallback walk gave up on, a meta step landing, a refused
   * agent tool call — is an event on that job's stream, never a log line.
   * This seam takes only what has no job to fan out on or failed while fanning
   * out: a host callback that threw (`onJobCreated`, `middleware.onError`, a
   * subscriber, `transientRetry.isTransient`), a transcript append that
   * failed, a row `abandonOrphanedJobs` could not update. Defaults to the host
   * console (`consoleDiagnosticsLogger`); pass `silentDiagnosticsLogger` in
   * tests, or an adapter onto your own logger.
   */
  logger?: DiagnosticsLogger
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
  private readonly alternativesMode: 'auto' | 'off'
  private readonly maxAlternativeDepth: number
  private readonly fallbackDepth: number
  private readonly outputValidation: 'strict' | 'off'
  private readonly transientRetry?: TransientRetryConfig
  private readonly maxAgentDepth: number
  private readonly middleware: readonly DispatchMiddleware[]
  private readonly agentRunImpl?: AgentRunImpl
  private readonly transcriptStore?: TranscriptStore
  private readonly agentAssetBridge?: AgentAssetBridge
  private readonly askUser?: AskUserHandler
  private readonly catalogOptions?: BuildCatalogDescriptorsOptions
  private readonly patternSearch?: PatternSearch
  private readonly logger: DiagnosticsLogger
  /**
   * Capture the per-dispatch envelope under the jobId of the agent dispatch.
   * Populated inside dispatchAgent on completion (both
   * success and error paths). Host retrieves via `getAgentEnvelope(jobId)`
   * after observing the job's terminal event (`job:completed` /
   * `job:failed`).
   *
   * Bounded (see MAX_AGENT_ENVELOPES): a host that reads the envelope and
   * calls `disposeAgentEnvelope(jobId)` keeps the map at the size of its
   * in-flight work, and one that never disposes still cannot grow it without
   * bound — the oldest entry is evicted on overflow. Eviction only ever costs
   * an envelope old enough that its dispatch settled long ago, which is why
   * `getAgentEnvelope` documents `undefined` as a normal answer. Both methods
   * are InlineRuntime-only (not on the Runtime contract).
   */
  private readonly agentEnvelopes = new Map<string, AgentDispatchEnvelope>()

  constructor(init: InlineRuntimeInit) {
    this.store = init.store
    this.registry = init.registry
    this.router = init.router
    this.resolveCtxProvider = init.resolveCtxProvider
    this.onJobCreated = init.onJobCreated
    this.alternativesMode = init.alternatives ?? DEFAULT_ALTERNATIVES_MODE
    this.maxAlternativeDepth =
      init.maxAlternativeDepth ?? DEFAULT_MAX_ALTERNATIVE_DEPTH
    this.fallbackDepth = init.fallbackDepth ?? DEFAULT_FALLBACK_DEPTH
    this.outputValidation = init.outputValidation ?? DEFAULT_OUTPUT_VALIDATION
    this.transientRetry = init.transientRetry
    this.maxAgentDepth = init.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH
    this.middleware = init.middleware ?? []
    this.agentRunImpl = init.agentRunImpl
    this.transcriptStore = init.transcriptStore
    this.agentAssetBridge = init.assetBridge
    this.askUser = init.askUser
    this.catalogOptions = init.catalogOptions
    this.patternSearch = init.patternSearch
    this.logger = init.logger ?? consoleDiagnosticsLogger
  }

  /**
   * Runs the dispatch to completion before resolving — the returned Job is
   * already terminal and every job event has fired. Subscribe from the
   * `onJobCreated` init hook to observe progress; subscribing after this
   * promise resolves observes nothing.
   *
   * Failure is data, not a rejection. Once a job row exists, whatever happens
   * to it — a provider failure, a middleware reject, a guard trip, a cancel —
   * lands on that row as `status: 'error'` (with `error` populated) or
   * `status: 'cancelled'`, the matching `job:failed` / `job:cancelled` event
   * fans out, and this promise resolves with the row. Read `job.status`; a
   * `try/catch` around this call never sees a dispatch failure.
   *
   * The promise rejects only when the request never became a job: an
   * unregistered `patternId` (`PATTERN_NOT_REGISTERED`), an input the
   * idempotency key cannot be derived from, a store that refuses the INSERT.
   * The rule is "a request that could not become a job throws; a job that
   * ran and failed returns". One case sits between the two and also rejects:
   * the row exists but the store failed to persist its terminal state. The
   * Job this call could hand back would then misreport where the work ended,
   * so the underlying error surfaces instead.
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
    //
    // `_submitJobInternal` keeps THROWING on a failed dispatch, and the
    // recursive callers want that: the throw is what unwinds a meta's compose
    // at a failed `ctx.step`, and what carries CANCELLED up a cascade. Only
    // this public boundary turns the throw back into the persisted row. It
    // can tell a pre-row failure from a post-row one because the per-call
    // `onJobCreated` capture — the same seam `submitAgentAsync` resolves its
    // jobId through — fires exactly when a row becomes addressable.
    let jobId: string | undefined
    try {
      return await this._submitJobInternal<TIn, TOut>(
        spec,
        [],
        undefined,
        undefined,
        undefined,
        { onJobCreated: (id) => { jobId = id } },
      )
    } catch (err) {
      // No row was ever created: the request itself was bad, and there is no
      // Job to describe it with.
      if (jobId === undefined) throw err
      const row = (await this.store.get(jobId)) as Job<TIn, TOut> | null
      // The row exists but never reached terminal, so the failure is in the
      // persistence path, not the dispatch — the row would misreport it.
      if (!row || row.status === 'queued' || row.status === 'running') throw err
      return row
    }
  }

  /**
   * Async agent dispatch. Fire-and-forget: returns `{ jobId }` as soon as the
   * queued row is INSERTed (or, on a dedup hit,
   * the existing job's id). The agent loop runs in the background; observe
   * progress + terminal state via `runtime.subscribe(jobId, ...)`. Same code
   * path as `submitJob` (jobs table + idempotency dedup + pub-sub stay
   * unchanged) but stamps `jobKind: 'agent'` on the row so the host can
   * cheaply filter agent runs out of a job listing, or route cross-session
   * listeners, without joining against the pattern registry.
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
   * It has to be an explicit parameter: the dispatching parent's controller is
   * the only thing that knows the live signal, and threading it through the
   * call chain is what makes the cascade real. Deriving it from a side table
   * keyed by sessionId looks equivalent and is not — nothing would populate it
   * for a nested dispatch, and the cascade would silently do nothing.
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
      throw Object.assign(
        new Error(`PATTERN_NOT_REGISTERED: ${spec.patternId}`),
        { code: 'PATTERN_NOT_REGISTERED' },
      )
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
        // Absent on every spec whose step did not opt out of positional
        // identity, and conditionally spread inside the derivation, so this
        // forwarding leaves existing keys untouched.
        stepKey: spec.stepKey,
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
        catch (e) { this.logger.warn(`[runtime] onJobCreated (agent dedup) threw for ${winner.id}:`, e) }
      }
      // Fire the per-call capture so a fire-and-forget caller (submitAgentAsync)
      // still sees the addressable jobId.
      if (opts?.onJobCreated) {
        try { opts.onJobCreated(winner.id) }
        catch (e) { this.logger.warn(`[runtime] opts.onJobCreated threw for ${winner.id}:`, e) }
      }
      return winner as Job<TIn, TOut>
    }

    if (this.onJobCreated) {
      try { this.onJobCreated(id, spec as JobSpec) }
      catch (e) { this.logger.warn(`[runtime] onJobCreated threw for ${id}:`, e) }
    }
    // Per-call capture fires AFTER the constructor-level hook so the host
    // correlation map (host requestId → jobId) is populated first, then
    // the fire-and-forget caller resolves its Promise.
    if (opts?.onJobCreated) {
      try { opts.onJobCreated(id) }
      catch (e) { this.logger.warn(`[runtime] opts.onJobCreated threw for ${id}:`, e) }
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
    //
    // The supplied value still meets the Pattern's `outputs` schema. It is
    // standing in for what an adapter would have returned — it lands in
    // `job.output` and, for a child job, in the next step's input — so it makes
    // that adapter's claim and answers to that adapter's gate. Anything else
    // leaves one exit where "every string field is bounded, so an unbounded
    // blob is unrepresentable" is a declaration rather than a fact. A cache
    // entry the schema now rejects is a stale entry, and failing loudly is
    // what a host wants over serving it.
    //
    // `runOnErrorChain` runs before `markErrored`, as on the dispatch path, and
    // it deliberately starts at 0: the middleware that supplied the value is
    // the one that has to hear its entry was refused, or it serves the same
    // bytes on the next call.
    if (shortCircuit) {
      try {
        this.assertOutputConforms(pattern, shortCircuit.output)
      } catch (err) {
        const e = normaliseError(err)
        await this.runOnErrorChain(id, e)
        await this.markErrored(id, e)
        throw err instanceof Error ? err : new Error(`${e.code}: ${e.message}`)
      }
      await this.store.update(id, {
        status: 'done',
        output: shortCircuit.output,
        updatedAt: Date.now(),
      })
      const final = (await this.store.get(id)) as Job<TIn, TOut> | null
      if (!final) {
        throw Object.assign(
          new Error(`JOB_LOST_AFTER_COMPLETION: ${id}`),
          { code: 'JOB_LOST_AFTER_COMPLETION' },
        )
      }
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
        throw Object.assign(
          new Error('CANCELLED: job cancelled before completion'),
          { code: 'CANCELLED' },
        )
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
      if (!final) {
        throw Object.assign(
          new Error(`JOB_LOST_AFTER_COMPLETION: ${id}`),
          { code: 'JOB_LOST_AFTER_COMPLETION' },
        )
      }
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
        throw err instanceof Error
          ? err
          : Object.assign(new Error(`CANCELLED: ${String(err)}`), {
              code: 'CANCELLED',
            })
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
        this.logger.error(`[runtime] middleware.onError threw for ${id}:`, e)
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
      throw Object.assign(
        new Error(`ALTERNATIVE_DEPTH_EXCEEDED: ${pattern.id}`),
        { code: 'ALTERNATIVE_DEPTH_EXCEEDED' },
      )
    }

    // Permission gate for the two kinds whose branches return below. The atomic
    // path runs the same hook further down, once it has forked a
    // DispatchContext; meta and agent never reach that line, so without this
    // the hook `PatternBase.checkPermissions` documents was dead for both of
    // them — a host that wrote one believed it had a gate it did not have.
    //
    // The context passed here is the pre-fork minimum. That is the point, not a
    // shortcut: the fork is an atomic-path construction, and a meta must not be
    // handed one — the same layering that keeps `ctx.step` off the atomic
    // adapter's context keeps it off a hook that runs before compose starts.
    if (pattern.kind !== 'atomic') {
      await this.assertPermitted(pattern, spec.input, {
        signal,
        assets: spec.assets ?? [],
        rootJobId: metaSharedState?.rootJobId ?? jobId,
        ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      })
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
      return dispatchAgent<TIn, TOut>(
        this.agentDispatchDeps(),
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
    // The caller's side of `appliesWhen: { kind: 'preserves-required' }` —
    // see readRequiresSemantics for why it comes off the input.
    const requestedSemantics = readRequiresSemantics(spec.input)
    const effectiveInput = spec.input

    const baseCtx = this.resolveCtxProvider?.(spec) ?? {}

    // Satisfiability phase: proactive check (consults Router).
    // DESIGN: atomic-id-as-capability-lookup
    const sat = this.router.checkSatisfiable(
      atomic.id as Capability,
      requiredTags,
      baseCtx,
    )

    if (!sat.ok) {
      if (this.alternativesMode === 'auto') {
        const alt = pickAlternative({ registry: this.registry, router: this.router }, atomic, baseCtx, requiredTags, requestedSemantics)
        if (alt) {
          return runAlternative<TIn, TOut>(
      {
        registry: this.registry,
        router: this.router,
        store: this.store,
        fanout: (id, ev) => this.fanout(id, ev),
        dispatch: (jid, pat, sp, sig, vis, d, mss, pctx) =>
          this.dispatch(jid, pat, sp, sig, vis, d, mss, pctx),
      },
      jobId, alt, spec, signal, visited, depth + 1, parentCtx)
        }
      } else {
        // Redirects are off (the default): fail, but name what was on the
        // table. A declared path that would have matched is the one thing the
        // caller cannot re-derive from the router error, so it travels
        // structurally on the JobError rather than only in prose.
        const applicable = applicableAlternatives(
          { registry: this.registry, router: this.router },
          atomic,
          baseCtx,
          requiredTags,
          requestedSemantics,
        )
        if (applicable.length > 0) {
          throw new AlternativesNotEnabledError(
            atomic.id as Capability,
            sat.reason,
            applicable,
          )
        }
      }
      // No alternative to take (or none declared at all). Terminal no-model
      // error: route through router.resolve so the error is built at the
      // single router seam — a host router that decorates resolve() errors
      // (e.g. with UI remedy text) covers this path too, and the message stays
      // consistent with every other no-model throw.
      this.router.resolve(atomic.id as Capability, requiredTags, baseCtx)
      // resolve() unexpectedly succeeded right after checkSatisfiable said
      // no (racing catalog change) — still unavailable this dispatch.
      throw new NoModelForCapabilityError(
        atomic.id as Capability,
        requiredTags,
        sat.reason,
      )
    }

    // Dispatch phase — Router resolve + ModelCapability.call, with the models
    // this dispatch has given up on accumulated into excludeModel so each
    // fallback hop resolves a different candidate. Seeded from the host's own
    // baseCtx.excludeModel, which is therefore honoured on the very first
    // resolve.
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
        // Correlation only — the adapter needs a stable key to file a
        // provider-side job reference under, and under a meta this dispatch's
        // own jobId is one the caller never saw. `MetaSharedState.rootJobId` is
        // claimed once by the top-level meta and inherited through nesting, so
        // every dispatch in one tree reports the same value.
        rootJobId: metaSharedState?.rootJobId ?? jobId,
        ...(spec.providerOptions ? { providerOptions: spec.providerOptions } : {}),
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      },
    )
    // Synchronous permission gate (NOT a HITL seam — mid-run "ask the user" lives
    // only on MetaPattern.compose via ctx.askUser; atomic confirms, e.g. cost, are
    // a host dispatch-policy concern). The atomic path runs it here rather than
    // in the pre-branch gate above so the hook receives the forked
    // DispatchContext — the same one `model.call` will get, resolved assets
    // included — instead of the pre-fork minimum meta and agent get.
    await this.assertPermitted(pattern, effectiveInput, dispatchCtx)

    // Two budgets, two loops, and neither can spend the other's.
    //
    // OUTER — the fallback walk. Each hop resolves the next candidate with the
    // models this dispatch has given up on already in excludeModel. A host
    // with a configured chain sets baseCtx.fallbackDepth from its length so the
    // whole order is walked; otherwise the runtime default bounds it.
    //
    // INNER — same-model transient retry. Opt-in: without
    // `InlineRuntimeInit.transientRetry` wired its body runs exactly once and
    // falls straight through to the exclusion below, so the default path is
    // unchanged by this option existing. A model is excluded only once this
    // loop is done with it, so a retried blip never costs a fallback hop and a
    // long fallback chain never buys extra attempts at one provider.
    // DESIGN: two-budgets-two-loops
    const fallbackBound = baseCtx.fallbackDepth ?? this.fallbackDepth
    const transientRetry = this.transientRetry
    for (let hop = 0; hop <= fallbackBound; hop++) {
      if (signal.aborted) throw cancelledError('aborted before the next fallback hop')
      const ctx: ResolveContext = { ...baseCtx, excludeModel }
      let model
      try {
        model = this.router.resolve(atomic.id as Capability, requiredTags, ctx)
      } catch (e) {
        // Router exhausted — fall through to alternatives. Preserve any
        // prior model.call error: when the walk has pushed the pinned model
        // into excludeModel, router throws MODEL_EXCLUDED as a symptom; the
        // real cause is the underlying provider error from hop 0's call
        // (auth / endpoint / network / model not supported). Overwriting
        // lastErr here would mask that and chat UI shows the misleading
        // "model excluded" instead of "not supported model for image gen".
        if (!lastErr) lastErr = e
        break
      }
      // Adapter-contract gate — the last thing between a resolved envelope and
      // its `call`, so every dispatch (primary, fallback hop) passes through
      // it. Deliberately OUTSIDE the try below: an envelope built for a
      // contract generation this build cannot execute is a wiring error, not a
      // transient provider failure, so it must not be swallowed into
      // excludeModel and silently routed around. It throws
      // MODEL_SPEC_VERSION_UNSUPPORTED with a machine-readable diagnostic.
      // It also sits outside the transient-retry loop: re-calling an envelope
      // this build cannot execute would fail identically every time.
      assertSupportedModelSpecVersion(model)
      const modelKey = `${model.provider}:${model.modelId}`
      // Declared outside the loop header so the count survives the `break`
      // below: it is the `attempts` that `job:model-fallback` reports.
      let attempt = 0
      for (;;) {
        attempt++
        let output: TOut
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
          output =
            result && typeof result === 'object' && 'output' in result
              ? (result as DispatchResult<TOut>).output
              : (result as unknown as TOut)
        } catch (e) {
          lastErr = e
          // Stamp the failed model onto the error before the loop moves on —
          // normaliseError lifts it (plus any httpStatus the host attached) into
          // JobError.details so the host can derive the exclusion set for the
          // LLM's retry without parsing the message text. ??= keeps the FIRST
          // failure's model when later attempts re-throw the same object.
          if (e instanceof Error) {
            ;(e as Error & { failedModel?: string }).failedModel ??= modelKey
          }
          // Nothing is printed here. An error log line used to sit here so
          // the real provider error would not be masked by the
          // MODEL_EXCLUDED the next hop's resolve reports once modelKey is in
          // excludeModel. That masking is answered by `job:model-fallback`
          // instead — emitted below, once this loop is done with the model —
          // which carries this hop's own error and attempt count: strictly
          // more than the log line did, on a channel a host can consume.
          // Ask the host first, THEN the policy: a `false` verdict must cost
          // nothing, so a fatal failure is not delayed by a backoff it was
          // never going to use.
          const delayMs =
            transientRetry && classifyTransient(transientRetry, this.logger, e, {
              capability: atomic.id as Capability,
              model: modelKey,
              attempt,
            })
              ? nextRetryDelayMs(transientRetry.policy, attempt)
              : null
          if (delayMs === null) break
          // Backoff — abortableSleep rejects with CANCELLED the moment the
          // signal fires, so a cancel mid-backoff surfaces immediately instead
          // of after the delay has been slept out.
          await abortableSleep(delayMs, signal)
          continue
        }
        // The output gate sits OUTSIDE the try above, beside the spec-version
        // assert and for the same reason: a mismatch is an adapter-contract
        // violation, not a provider failure. Inside the try it would be put to
        // `isTransient`, which has no business classifying it, and the model
        // would land in excludeModel with the walk paying a second provider
        // for a second output — when the first is already here, already paid
        // for, and riding on the error as `details.rawOutput`.
        this.assertOutputConforms(pattern, output)
        return output
      }
      // Giving up on this model goes out on the job stream — once per hop,
      // never per attempt — because only the final attempt's error survives
      // to `job:failed`; each hop's own cause is visible nowhere else. Fields
      // are snapshotted here: fanoutJobEvent runs after a store read, by which
      // time `lastErr` may already belong to the next hop. `lastErr` is set —
      // the only way out of the loop above without returning is the `break`
      // in its catch.
      const error = normaliseError(lastErr)
      const attempts = attempt
      void this.fanoutJobEvent(jobId, (job) => ({
        type: 'job:model-fallback',
        job,
        capability: atomic.id as Capability,
        failedModel: modelKey,
        hop,
        attempts,
        error,
      }))
      excludeModel.push(modelKey)
    }

    // Router/model exhausted — fall through to Pattern.alternatives, if the
    // host enabled them. With `alternatives: 'off'` this path rethrows the
    // primary failure verbatim rather than an ALTERNATIVES_NOT_ENABLED error:
    // here a model was found and its call failed (auth, invalid input,
    // network), and that provider error is the actionable one — restating it
    // as a routing-policy code would mask the cause the host needs.
    const alt =
      this.alternativesMode === 'auto'
        ? pickAlternative({ registry: this.registry, router: this.router }, atomic, baseCtx, requiredTags, requestedSemantics)
        : null
    if (!alt) {
      throw lastErr instanceof Error
        ? lastErr
        : Object.assign(new Error(`DISPATCH_EXECUTE_FAILED: ${String(lastErr)}`), {
            code: 'DISPATCH_EXECUTE_FAILED',
          })
    }
    const mapped = await runAlternative<TIn, TOut>(
      {
        registry: this.registry,
        router: this.router,
        store: this.store,
        fanout: (id, ev) => this.fanout(id, ev),
        dispatch: (jid, pat, sp, sig, vis, d, mss, pctx) =>
          this.dispatch(jid, pat, sp, sig, vis, d, mss, pctx),
      },
      jobId, alt, spec, signal, visited, depth + 1, parentCtx)
    // The redirect's own dispatch checked the target's output against the
    // target's schema; `mapOutput` then reshaped it into THIS pattern's, and
    // that reshaped object is what the caller reads against this schema.
    this.assertOutputConforms(pattern, mapped)
    return mapped
  }

  /**
   * Run a Pattern's own `checkPermissions` hook, throwing PERMISSION_DENIED on
   * refusal. One implementation so the three kinds cannot drift in what they
   * throw; they differ only in the context they can supply (see both call
   * sites). Reads the hook off the `Pattern` spec interface — the concrete
   * class an atomic is cast to does not redeclare it.
   */
  private async assertPermitted(
    pattern: Pattern,
    input: unknown,
    ctx: DispatchContext,
  ): Promise<void> {
    if (typeof pattern.checkPermissions !== 'function') return
    const perm = await pattern.checkPermissions(input, ctx)
    if (!perm.ok) {
      throw Object.assign(new Error(`PERMISSION_DENIED: ${perm.reason}`), {
        code: 'PERMISSION_DENIED',
      })
    }
  }

  /**
   * The output gate: the one place an atomic or meta output meets the schema
   * its Pattern declared. Before it, the bound on every output field was an
   * authoring lint the registry audits at registration and nothing at run
   * time held an adapter to — a 70 KiB completion, a `{ text }` where the
   * schema promises `assets[]`, a meta that forgot `cost`, all flowed into the
   * next step and into `job.output` as if valid.
   *
   * Asserts and returns nothing on purpose: the caller hands back the object
   * it already holds. `z.object` strips unknown keys and fills defaults, so
   * `safeParse(...).data` is a reshaped copy, and returning it would be a
   * second transformation of the adapter's output that nobody asked for and
   * nothing announces — an extra key a host put there for its own bookkeeping
   * would vanish between the adapter and `job.output`. The question asked
   * here is "does this conform", never "what would it look like if it did".
   *
   * The agent kind is not checked on the dispatch path: its output is composed
   * from a finish payload the finish tool already validated (or an
   * `outputExtractor` result already parsed), so a second pass would only
   * re-run the same schema. A middleware short-circuit is the exception —
   * no finish tool ran there, so a supplied output answers to this gate
   * whatever the Pattern's kind.
   * DESIGN: output-schema-mismatch-gate
   */
  private assertOutputConforms(pattern: Pattern, output: unknown): void {
    if (this.outputValidation === 'off') return
    const schema = pattern.outputs
    // `outputs` is required on the atomic and meta narrows; only an agent may
    // omit it. A spec that reached the runtime through a cast can still lack
    // one, and a missing schema is the registry's complaint, not this gate's.
    if (!schema || typeof schema.safeParse !== 'function') return
    const parsed = schema.safeParse(output)
    if (parsed.success) return
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map((seg) => (typeof seg === 'symbol' ? seg.toString() : seg)),
      message: issue.message,
    }))
    const named = issues
      .slice(0, 3)
      .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ')
    const more = issues.length > 3 ? `; and ${issues.length - 3} more` : ''
    throw Object.assign(
      new Error(
        `OUTPUT_SCHEMA_MISMATCH: ${pattern.id} (${pattern.kind}) returned an output ` +
          `its schema rejects — ${named}${more}`,
      ),
      {
        code: 'OUTPUT_SCHEMA_MISMATCH',
        details: { patternId: pattern.id, kind: pattern.kind, issues, rawOutput: output },
      },
    )
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
      throw Object.assign(
        new Error(`META_PATTERN_NO_COMPOSE: ${meta.id}`),
        { code: 'META_PATTERN_NO_COMPOSE' },
      )
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
        // Sub-steps settle on the parent's stream: a meta is one Job to the
        // caller, so without this a multi-minute chain is silent between
        // job:started and job:completed.
        // DESIGN: job-step-not-namespaced
        onStepSettled: ({ rootJobId, stepId, patternId, childJobId, output }) => {
          void this.fanoutJobEvent(rootJobId, (job) => ({
            type: 'job:step',
            job,
            stepId,
            patternId,
            childJobId,
            ...(stepAssets(output) ? { assets: stepAssets(output) } : {}),
          }))
        },
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
      // spec.stepIdNamespace undefined → ctx adds no prefix. A nested meta
      // picks up its parent's effective step id and prefixes its own internal
      // stepIds with it.
      spec.stepIdNamespace,
    )

    const output = await meta.compose(
      { input: spec.input },
      ctx,
    )
    this.assertOutputConforms(pattern, output)
    return output as TOut
  }


  // ── Runtime interface ────────────────────────────────────────────────────

  async pollJob<TIn = unknown, TOut = unknown>(
    jobId: string,
  ): Promise<Job<TIn, TOut>> {
    const job = await this.store.get(jobId)
    if (!job) {
      throw Object.assign(new Error(`JOB_NOT_FOUND: ${jobId}`), {
        code: 'JOB_NOT_FOUND',
      })
    }
    return job as Job<TIn, TOut>
  }

  /**
   * Look up the envelope captured during a completed (or errored) AgentPattern
   * dispatch. Returns `undefined` for non-agent
   * jobIds, jobs that haven't settled yet, or after the entry was cleared
   * by `cancelJob` / explicit `disposeAgentEnvelope`.
   *
   * Typical usage: after observing `job:completed` / `job:failed` for a job
   * whose pattern is `kind: 'agent'`, call `runtime.getAgentEnvelope(job.id)` to
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
    if (!existing) {
      throw Object.assign(new Error(`JOB_NOT_FOUND: ${jobId}`), {
        code: 'JOB_NOT_FOUND',
      })
    }
    if (
      existing.status === 'done' ||
      existing.status === 'error' ||
      existing.status === 'cancelled' ||
      existing.status === 'stale'
    ) {
      throw Object.assign(
        new Error(`JOB_ALREADY_TERMINAL: ${jobId} is ${existing.status}`),
        { code: 'JOB_ALREADY_TERMINAL' },
      )
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
   * the store is consistent after a crash. Best-effort per row — one row
   * that fails to update does not stop the rest. See
   * Runtime.abandonOrphanedJobs for the substrate contract.
   */
  async abandonOrphanedJobs(): Promise<readonly Job[]> {
    const stuck = await this.store.query({
      status: ['queued', 'running'] as readonly JobStatus[],
    })
    const abandoned: Job[] = []
    for (const job of stuck) {
      try {
        await this.store.update(job.id, { status: 'stale', updatedAt: Date.now() })
        const next = await this.store.get(job.id)
        if (next) {
          abandoned.push(next)
          this.fanout(job.id, { type: 'job:stale', job: next })
        }
      } catch (e) {
        this.logger.warn(`[runtime] abandonOrphanedJobs failed for ${job.id}:`, e)
      }
    }
    return abandoned
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
      this.logger.warn(`[runtime] fanoutJobEvent failed for ${jobId}:`, e)
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

  /**
   * The runtime capabilities agent dispatch borrows. Built per dispatch so the
   * agent module never holds a reference to the runtime itself.
   */
  private agentDispatchDeps(): AgentDispatchDeps {
    return {
      registry: this.registry,
      maxAgentDepth: this.maxAgentDepth,
      agentRunImpl: this.agentRunImpl,
      transcriptStore: this.transcriptStore,
      agentAssetBridge: this.agentAssetBridge,
      catalogOptions: this.catalogOptions,
      patternSearch: this.patternSearch,
      resolveCtxProvider: this.resolveCtxProvider,
      logger: this.logger,
      recordEnvelope: (jobId, envelope) => {
        // Evict the oldest entry once full (Map iterates in insertion order),
        // mirroring the meta stepCache bound. Delete-then-set so re-recording
        // the same jobId refreshes its position rather than aging in place.
        this.agentEnvelopes.delete(jobId)
        if (this.agentEnvelopes.size >= MAX_AGENT_ENVELOPES) {
          const oldest = this.agentEnvelopes.keys().next().value
          if (oldest !== undefined) this.agentEnvelopes.delete(oldest)
        }
        this.agentEnvelopes.set(jobId, envelope)
      },
      fanoutJobEvent: (jobId, build) => this.fanoutJobEvent(jobId, build),
      submitChild: (spec, ancestors, mss, parentSignal, parentCtx) =>
        this._submitJobInternal(spec, ancestors, mss, parentSignal, parentCtx),
    }
  }

  private fanout(jobId: string, event: JobEvent): void {
    const set = this.subscribers.get(jobId)
    if (set && set.size > 0) {
      for (const cb of [...set]) {
        try { cb(event) }
        catch (e) { this.logger.error('[runtime] subscriber threw:', e) }
      }
    }
    // A terminal event is the last one this jobId can ever emit, so the
    // subscriber set is dead weight from here on. Dropping it after the
    // delivery means a host that never calls its Unsubscribe still leaves
    // nothing behind; the returned Unsubscribe stays safe to call, because it
    // tolerates the entry already being gone.
    if (TERMINAL_EVENTS.has(event.type)) this.subscribers.delete(jobId)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────



// Re-export the historical class name so callers that imported
// `InlineRuntimeAdapter` keep working through this transition.
export { InlineRuntime as InlineRuntimeAdapter }

// ExecutionContext is constructed by dispatchMeta via
// `buildMetaExecutionContext` (see `./meta-execution-context.ts`). Carries
// submitJob + step + compute + abort signal. Hosts that need it for other
// paths (e.g. driving an atomic call adapter from outside the runtime)
// wrap InlineRuntime themselves.
// Agent dispatch moved to ./agent-dispatch; re-exported so the package
// surface (and every existing import from './inline') is unchanged.
export { buildAgentInlineCore, countAgentAncestors }
export type { AgentAssetBridge }

export type { ExecutionContext }
