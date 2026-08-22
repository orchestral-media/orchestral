// Job, JobSpec, JobEvent — runtime contract. Lives in @orchestral/core as
// part of the substrate-agnostic vocabulary; concrete runtime
// implementations (e.g. @orchestral/runtime) consume these types.

import type { PatternId } from './foundational'
import type { Capability } from './capability'
import type { Artifact } from './pattern'
import type { ResolvedAssetRef } from './asset-index.types'
import type { Semantics } from './alternative'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  /**
   * Runtime found this row in 'running' at startup with no live controller
   * and abandoned it — no way to tell whether the provider call ever landed.
   */
  | 'stale'

export interface JobError {
  code: string
  message: string
  /** Optional underlying cause — preserved via Error.cause. */
  cause?: unknown
  details?: unknown
  /**
   * assetIds an AgentPattern produced before failing. Lets the parent
   * reference partial work in the failure tool-result. Set by the runtime when
   * a dispatchAgent throw carries `producedAssets`; absent for non-agent jobs.
   */
  producedAssets?: readonly string[]
}

/**
 * Discriminator on the Job row that tells the host whether to treat it as a
 * regular pattern dispatch ('pattern' — the default) or as a long-running
 * async agent run ('agent'). Free-form TEXT in storage so
 * future kinds (e.g. 'workflow', 'batch') slot in without a column migration;
 * runtime stays the source of truth for valid values.
 */
export type JobKind = 'pattern' | 'agent'

/**
 * Runtime promotes a JobSpec to a Job by adding id / status / output / error /
 * timestamps and (if omitted) deriving a deterministic idempotencyKey from
 * a canonical hash of (patternId, input, sessionId, stepIndex).
 */
export interface Job<TInput = unknown, TOutput = unknown> {
  id: string
  patternId: PatternId
  /** Same key = same job. Resubmit returns the existing job instead of dispatching. */
  idempotencyKey: string
  status: JobStatus
  input: TInput
  output: TOutput | null
  error: JobError | null
  createdAt: number
  updatedAt: number
  sessionId?: string
  /**
   * Optional discriminator (default 'pattern'). Async agent
   * dispatch sets 'agent' so the host can cheaply filter long-running runs
   * from regular pattern jobs when querying or listing jobs.
   */
  jobKind?: JobKind
}

/**
 * User-facing submission shape.
 *
 * `assets` carries the resolution pass output: real
 * assetIds keyed by slot, pre-resolved by the host before submitJob (the LLM
 * only ever filled handles in `input.references`). The runtime threads these
 * straight into `DispatchContext.assets` for the adapter. Never appears in
 * the LLM tool catalog.
 *
 * The fields fall into two groups, and the split is load-bearing:
 *
 *   IDENTITY — folded into the derived idempotency key, so changing one makes
 *   this a different job: `patternId`, `input`, `assets` (the resolution-pass
 *   output — the same literal input over different resolved source assets is
 *   different work), `sessionId`, `stepIndex`. (`idempotencyKey` itself, when
 *   supplied, replaces the derivation.)
 *
 *   ROUTING METADATA — tells the runtime and adapters *how* to execute this
 *   submission, and is deliberately excluded from the key: `providerOptions`,
 *   `assetContextId`, `resolveHints`, `stepIdNamespace`, `resumeFromRunId`,
 *   `jobKind`.
 *
 * The rule behind the split: two submissions that ask for the same result must
 * dedupe even when the host routes them differently. A retry that excludes a
 * failed model, or a resumed agent run, is a different execution attempt of the
 * same request — hashing routing metadata would defeat the dedupe it exists to
 * serve. `deriveIdempotencyKey` hand-picks the identity fields rather than
 * hashing the whole spec, so a new routing field is excluded by default; a new
 * identity field must be added there explicitly.
 */
export interface JobSpec<TInput = unknown> {
  patternId: PatternId
  input: TInput
  /** Resolution pass output — real assetIds keyed by slot. */
  assets?: readonly ResolvedAssetRef[]
  /**
   * Host-validated providerOptions defaults, sourced from wherever the host
   * keeps per-model settings. The runtime threads them into
   * `DispatchContext.providerOptions` so the adapter can merge them under the
   * LLM-explicit `input.providerOptions` (LLM wins).
   * Never appears in the LLM tool catalog. Omit = no host
   * defaults → merge is a pass-through of input.providerOptions only.
   */
  providerOptions?: Record<string, unknown>
  sessionId?: string
  /**
   * The asset-ledger context that `input.references` handles (and any
   * sub-step handles a meta forwards) live in. Handles are minted per context
   * and collide across contexts — image_1 in one names a different asset than
   * image_1 in another — so the resolver needs to be told which one to read.
   * An agent loop sets its own runId here, so a meta dispatched as an agent
   * sub-tool resolves against the AGENT's per-run ledger rather than the
   * enclosing session's. Absent = the session itself is the context. Routing
   * metadata only — never hashed into the idempotency key.
   */
  assetContextId?: string
  /**
   * Host hints for model resolution on THIS dispatch. `excludeModel` seeds
   * `ResolveContext.excludeModel` (the host's resolveCtxProvider reads it) so
   * an LLM retry after a provider failure lands on the next candidate — the
   * host derives the set from job history at dispatch time; the runtime never
   * writes it. Routing metadata only — never hashed into the idempotency key
   * (deriveIdempotencyKey hand-picks fields), and correctly so: a retry with a
   * different exclusion set is a different execution attempt, while failed
   * rows never dedupe anyway.
   */
  resolveHints?: { excludeModel?: readonly string[] }
  /** Omit to let the runtime derive via canonical JSON hash. */
  idempotencyKey?: string
  /** Position in a MetaPattern step list — folded into idempotency hash. */
  stepIndex?: number
  /**
   * stepId namespace prefix a parent meta stamps onto a child
   * meta's spec. The child meta uses it to namespace its OWN internal stepId
   * space (stepCache key + duplicate-detection set), so the SAME meta type
   * dispatched multiple times in one tree (e.g. meta_storyboard rendering
   * panel-0 and panel-1, each running meta_image-best-of-n with fixed explicit
   * stepIds `candidate-0`…) doesn't collide on those explicit ids or
   * cross-contaminate the shared stepCache. The parent sets it to the
   * EFFECTIVE stepId of the step launching the child (e.g. `panel-0`), so the
   * child's `candidate-0` becomes `panel-0/candidate-0` — deterministically
   * unique at any nesting depth. Top-level meta dispatches leave it absent,
   * so no prefix is applied.
   *
   * Routing metadata only — NEVER hashed into the idempotency key
   * (deriveIdempotencyKey hand-picks fields; this one is excluded by design).
   */
  stepIdNamespace?: string
  /**
   * Opt-in resume for agent dispatches.
   *
   * When set, dispatchAgent looks up the prior agent transcript at
   * `(resumeFromRunId, agent_id)` and reconstructs the LLM seed messages
   * before invoking AgentRunImpl. Default is no resume (fresh agent start)
   * so callers never accidentally rehydrate a stale or terminated run.
   *
   * `resumeFromRunId` typically equals the original parent Job.id whose
   * sessionId was used as the transcript runId. Requires the runtime to
   * have a `transcriptStore` injected; throws if not.
   */
  resumeFromRunId?: string
  /**
   * Opt-in marker for async agent dispatch. `undefined` defaults to
   * 'pattern'; `submitAgentAsync` sets this to 'agent' so the persisted jobs
   * row records the discriminator.
   */
  jobKind?: JobKind
}

/**
 * Why a brokered agent tool call was refused, and the facts that make the
 * refusal judgeable. The three codes are exactly the ones the runtime returns
 * to the calling LLM as the tool-result `code`, so a host can join an event to
 * the verdict the model actually read.
 *
 * Discriminated rather than a single flat bag: each refusal knows a different
 * thing. An out-of-scope call can only be judged against the allowlist it
 * failed, a cycle only against the chain it would have closed, and a blocklist
 * hit only against which half of the blocklist matched — a shared shape would
 * leave two thirds of its fields empty at every callsite.
 */
export type AgentToolRejection =
  | {
      /** The target is already on this dispatch chain — dispatching it would close a ring. */
      code: 'CIRCULAR_AGENT_TOOL'
      /** The ancestor chain that reached the caller, in dispatch order. */
      ancestors: readonly PatternId[]
    }
  | {
      /** The target is not in the calling agent's declared tool allowlist. */
      code: 'SUBAGENT_TOOL_OUT_OF_SCOPE'
      /**
       * The allowlist the call was judged against — the EFFECTIVE one. For an
       * async agent that is `loop.toolPatternIds ∩ loop.asyncToolPatternIds`,
       * not the raw `toolPatternIds`, so a host reading this sees the same set
       * the guard used.
       */
      allowlist: readonly PatternId[]
    }
  | {
      /** The target matched the runtime's default sub-agent blocklist. */
      code: 'SUBAGENT_BLOCKED'
      /** Which half of the blocklist matched: an id prefix, or an exact id. */
      matched: 'prefix' | 'id'
    }

/**
 * Every event carries a snapshot of the Job after the transition — consumers
 * never need to refetch from the Store. Snapshot field name is consistent
 * across all event types so consumers can narrow on `type` and read `.job`
 * without further type checks.
 */
export type JobEvent<TInput = unknown, TOutput = unknown> =
  | { type: 'job:submitted'; job: Job<TInput, TOutput> }
  | { type: 'job:started'; job: Job<TInput, TOutput> }
  | {
      type: 'job:progress'
      job: Job<TInput, TOutput>
      /** 0..1 coarse progress fraction, runtime clamps the value. */
      fraction: number
      message?: string
    }
  | {
      type: 'job:artifact'
      job: Job<TInput, TOutput>
      /** Intermediate artifact (preview frame, draft image, etc). */
      artifact: Artifact
    }
  | {
      /**
       * A step inside a MetaPattern's `compose()` finished, fired on the
       * PARENT job's stream. A meta pipeline is one Job to the caller — its
       * sub-dispatches have their own ids the caller never sees — so without
       * this a long chain (image → video → speech) is silent from
       * `job:started` until the whole pipeline settles.
       *
       * Fired after the sub-dispatch settles successfully and before the next
       * step starts — exactly once per dispatched step, since `ctx.step`
       * rejects a repeated step id outright (DUPLICATE_STEP_ID) rather than
       * serving it twice. A failing step raises META_STEP_FAILED and fails the
       * parent instead, so this event only ever describes work that landed.
       *
       * `ctx.compute` is silent: it wraps a local function, so there is no
       * sub-dispatch and nothing a progress UI could correlate.
       */
      type: 'job:step'
      job: Job<TInput, TOutput>
      /** Author-facing step id, as passed to `ctx.step` (unnamespaced). */
      stepId: string
      /** The Pattern the step dispatched. */
      patternId: PatternId
      /** The sub-dispatch's own job id, for correlation against the store. */
      childJobId: string
      /**
       * Media the step produced, when its output carries an `assets` array —
       * this is what makes an intermediate frame or clip showable while the
       * rest of the pipeline is still running.
       */
      assets?: readonly { assetId: string; modality: string; url?: string }[]
    }
  | { type: 'job:output'; job: Job<TInput, TOutput> }
  | {
      /**
       * The model fallback walk gave up on a candidate and is moving on — to
       * the next hop, or past the last one to a declared Alternative / the
       * terminal failure. Fired once per hop, AFTER that candidate's same-model
       * transient retry budget is spent (never per attempt) and BEFORE the next
       * `resolve`, so a subscriber sees each provider's own error as it lands.
       *
       * This is the only place those errors are visible. Once a model is in
       * `excludeModel` the router reports it as MODEL_EXCLUDED, and only the
       * final attempt's error survives to `job:failed` — so without this event
       * the auth / quota / network failure that actually started the walk
       * would reach nobody.
       */
      type: 'job:model-fallback'
      job: Job<TInput, TOutput>
      capability: Capability
      /** `${provider}:${modelId}` of the model this dispatch has now given up on. */
      failedModel: string
      /** 0-based position in the fallback walk. */
      hop: number
      /** Attempts made against this model inside this hop (1 = no transient retry). */
      attempts: number
      /** The error that ended the last attempt, normalised. */
      error: JobError
    }
  | {
      /**
       * Dispatch fell through the primary path and is redirecting via a
       * declared Alternative. Fired once per redirect hop, BEFORE the
       * alternative target dispatches — a completion after this event means
       * the degraded path produced the output. Carries the Alternative's
       * declared degradation metadata so a UI can warn the user
       * ("identity preservation lost").
       */
      type: 'job:alternative-selected'
      job: Job<TInput, TOutput>
      /** `Alternative.id` — unique within the parent Pattern's list. */
      alternativeId: string
      /** `Alternative.description` — human-readable path summary. */
      description: string
      /** The redirect target (`Alternative.via.patternId`). */
      targetPatternId: PatternId
      preserves?: readonly Semantics[]
      losses?: readonly Semantics[]
    }
  | ({
      /**
       * An agent loop asked to dispatch a Pattern and a recursion guard
       * refused it. Fired on the AGENT job's own stream, once per refused
       * call, BEFORE the refusal is handed back to the model.
       *
       * The refusal itself is not a failure: the guards return a structured
       * tool-result so the loop picks a different `pattern_id` and keeps
       * going, so the job still settles `done` with `error: null` and the
       * refused call is not counted in `AgentDispatchEnvelope.totalToolUseCount`
       * (it brokered no tool use). Without this event the attempt would be
       * visible only inside the model's context window — a host could not
       * audit that an agent reached outside its scope, or that it kept
       * probing the same edge.
       */
      type: 'job:tool-rejected'
      job: Job<TInput, TOutput>
      /** The resolved `pattern_id` the loop asked for — the refused target. */
      patternId: PatternId
      /** The AgentPattern whose loop emitted the call. */
      callerPatternId: PatternId
    } & AgentToolRejection)
  | { type: 'job:completed'; job: Job<TInput, TOutput> }
  | { type: 'job:failed'; job: Job<TInput, TOutput> }
  | { type: 'job:cancelled'; job: Job<TInput, TOutput> }
  | { type: 'job:stale'; job: Job<TInput, TOutput> }
