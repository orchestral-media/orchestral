// ExecutionContext — the dispatch context plus the step/compute primitives.
//
// Model execution belongs to the host CapabilityRouter, so the only
// host-callable escape hatch on the base context is submitJob. MetaPattern
// composition adds ctx.step / ctx.compute on top: sub-Pattern dispatch and
// idempotent local-fn wrapping, each with retry / abort / metadata.

import type { ResolvedAssetRef } from './asset-index.types'
import type { Job, JobSpec } from './job'
import type { PatternRef } from './pattern-ref'
import type { ZodSchema } from './foundational'
import type { AskUserRequest, AskUserKind } from './pause'
import type { AskUser } from './ask-user'

// ── Step / Compute primitives ──────────────────────────────────────────────

/**
 * Retry policy for `ctx.step` / `ctx.compute`. One retry shape carries
 * across atomic dispatch and meta compose; hosts with their own step
 * runners can mirror it so a single mental model holds everywhere.
 */
export type RetryPolicy =
  | { kind: 'none' }
  | { kind: 'exponential'; maxAttempts: number; baseMs: number; maxMs?: number }
  | { kind: 'fixed'; maxAttempts: number; delayMs: number }

export interface StepOptions {
  /** Retry policy; default `{ kind: 'none' }`. */
  retry?: RetryPolicy
  /** Free-form observability metadata flows into workflow.json. */
  metadata?: Record<string, unknown>
  /**
   * Override the auto-generated stepId. Default = `${patternId}#${seq}`
   * where seq is the order of the call within this compose run. Use
   * explicit override for fan-out (`portrait-${i}`) where deterministic
   * order is needed for resume.
   */
  stepId?: string
  /**
   * What keys this step's durable JobStore row — which decides what a re-run
   * dedupes onto.
   *
   * - `'index'` (default): the tree-wide counter position keys the row. The
   *   step's ordinal within the compose run is hashed into the idempotency
   *   key, so inserting or reordering a step re-keys it and everything after
   *   it, even when nothing those steps read has changed.
   * - `'id'`: the namespaced stepId keys the row instead, and the position
   *   drops out. Steps then survive an edit elsewhere in the list. **Requires
   *   an explicit `stepId`** — the default id embeds the counter, so leaving
   *   it to the framework would put the position straight back into the key.
   *   `ctx.step` throws `STEP_IDENTITY_REQUIRES_STEP_ID` rather than key a row
   *   on `text-to-image#3`.
   *
   * Positional is the default because a shipped meta is write-once: its author
   * owns the step order the same way they own the code, and a reorder is a
   * code change they make deliberately and once (DESIGN.md's "we don't
   * content-hash step ids"). Under that model the counter is the cheaper
   * identity — nothing to name, nothing to keep unique, and the tree-shared
   * counter already tells two subtrees apart for free.
   *
   * The population that should opt in is the one whose step list is edited
   * *between runs by a model* rather than by a commit: an LLM-authored
   * pipeline, re-emitted with a step inserted after the user asked for one
   * more thing. There, reordering is routine rather than exceptional, and
   * paying to re-run every downstream step on each revision is the whole cost
   * of the feature. Naming the steps is also already free for such a caller —
   * it wrote the ids into the plan.
   *
   * Opting in changes nothing else: the counter still advances (so default
   * ids, nested namespaces and `job:step` events are untouched), the
   * duplicate-id guard still applies, and a step that does not set `identity`
   * hashes byte-identically to how it did before this option existed.
   */
  identity?: 'index' | 'id'

  /**
   * Key this step's durable row on a string the CALLER derives, bypassing
   * `deriveIdempotencyKey` entirely — the same override `JobSpec.idempotencyKey`
   * has always given a host submitting directly, reachable from inside a
   * `compose` where the framework, not the author, builds the child spec.
   *
   * Why the two `identity` modes are not enough. Both are projections of one
   * derivation, and that derivation hashes `sessionId` — "dedup never crosses
   * a session boundary" is a deliberate property of it, not an oversight. So a
   * caller whose notion of "the same work" is broader than one session cannot
   * express it by choosing a mode: name-keying survives an edit to the step
   * list, and still re-pays in a new session. Content-addressed reuse that
   * outlives the conversation the request arrived in is a key question, and
   * this is where a caller answers it.
   *
   * When present, `identity` stops mattering for the durable key: position and
   * name are both inputs to a derivation that no longer runs. Everything else
   * `identity` governs (which id the step reports, how nested namespaces
   * compose) is untouched, so a step may sensibly pass both.
   *
   * The whole burden moves with the key. The engine stops asking whether the
   * input changed, so a key that omits something the step actually reads hands
   * back the earlier output for later work — the failure mode is a stale
   * result, not an error. Derive it from everything the step depends on.
   */
  idempotencyKey?: string
}

export interface StepMeta {
  stepId: string
  attempts: number
  durationMs: number
}

export interface StepResult<T> {
  value: T
  meta: StepMeta
}

/**
 * `ctx.step` — dispatch a sub-Pattern with idempotency + retry + abort.
 *
 * Available inside `MetaPattern.compose()` only. An atomic Pattern is
 * restricted to the single `ModelCapability.call` its primary path resolves to
 * and never sees `ctx.step` — multi-step fallback goes through declarative
 * `alternatives` → meta.
 *
 * Defaults to plain value return; use `.withMeta()` to get the full
 * `{ value, meta }` shape when stepId / attempts / latency is needed for
 * progress UI or debug.
 * DESIGN: atomic-never-sees-ctx-step
 */
export interface CtxStepFn {
  <T = unknown>(ref: PatternRef, options?: StepOptions): Promise<T>
  withMeta<T = unknown>(
    ref: PatternRef,
    options?: StepOptions,
  ): Promise<StepResult<T>>
}

/**
 * `ctx.compute` — wrap an arbitrary local fn with idempotency + retry.
 * Use for expensive host code (ffmpeg / scenedetect / large IO) that
 * should survive crash + resume; cheap host derive (filter / map /
 * string ops) skip the wrapper entirely.
 */
export interface CtxComputeFn {
  <T = unknown>(
    id: string,
    fn: () => Promise<T>,
    options?: StepOptions,
  ): Promise<T>
}

export interface AskUserOptions<TPayload = unknown, TAnswer = unknown> {
  /**
   * What is being asked (choice→pick one / confirm→yes-no / form→edit fields),
   * never how it is rendered. The runtime routes on it without interpreting it;
   * the payload and answer shape each kind implies are defined by the schemas in
   * ask-user.ts. AskUserKind is shared with AskUserRequest.kind so the two
   * can't drift.
   */
  kind: AskUserKind
  /** The question as the user will see it — the payload for `kind`. */
  payload: TPayload
  /** Runtime-authoritative validation of the host's answer, parsed by the
   *  runtime bridge before the awaiting compose() resumes. */
  answerSchema?: ZodSchema<TAnswer>
}

/**
 * Host seam (injected via InlineRuntimeInit.askUser). The runtime calls it with
 * an AskUserRequest and awaits the returned promise — which the host resolves
 * with the user's (opaque) answer. The only HITL injection point.
 */
export type AskUserHandler = (request: AskUserRequest) => Promise<unknown>

// ── ExecutionContext ───────────────────────────────────────────────────────

/**
 * The base dispatch surface — host-injected context plus resolution results,
 * received by both atomic and meta. (AgentPattern sub-dispatch uses it too.)
 * Meta-only orchestration capabilities (step/compute/submitJob/…) extend
 * ExecutionContext on top of this.
 *
 * The atomic adapter's `ModelCapability.call(input, ctx)` receives this shape
 * (the runtime builds it on the atomic dispatch path); meta `compose` and
 * agent `loop.system` consume it too.
 */
export interface DispatchContext<P = unknown> {
  /**
   * AbortSignal fired when the parent job is cancelled. Always present —
   * runtimes default it to an unfired signal so callers don't need to
   * null-check. Pass straight through to fetch / your SDK's abort option.
   */
  signal: AbortSignal

  /**
   * The real assetIds produced by the resolution pass, for the adapter to read.
   * Populated by the runtime at dispatch time (host supplies AssetEvent →
   * resolveAssets → lands here).
   *
   * Currently optional because it is additive and not every dispatch consumes
   * it yet. Once resolution wiring is complete, the resolution pass should
   * return a narrowed type (`assets` always present) and the adapter parameter
   * should take it, turning "resolution ran ⇒ assets present" into a
   * compile-time invariant and avoiding `?? []` spreading downstream.
   * Semantics: **present = resolution ran (possibly an empty array); absent =
   * resolution did not run / this dispatch needs no assets**.
   */
  assets?: ReadonlyArray<ResolvedAssetRef>

  /**
   * Host-maintained providerOptions defaults, validated by the host against
   * the resolved model's self-reported options schema at the host boundary.
   */
  providerOptions?: Record<string, unknown>

  sessionId?: string

  /**
   * The jobId at the ROOT of this dispatch tree — the job the caller actually
   * submitted. On a top-level atomic dispatch it equals that job's own id; on
   * every dispatch under a meta it is the top-level meta's id, inherited
   * unchanged through nesting.
   *
   * This is a **correlation id, not a handle**: the runtime reads nothing from
   * it and stores nothing under it. It exists because the three things a host
   * routinely wants — attributing a provider-side job reference (a fal
   * `request_id`, a Replicate prediction id) to the dispatch that started it,
   * counting calls across one submitted job to enforce its own spend cap in
   * `beforeDispatch`, and grouping log lines from one `submitJob` — all need
   * the same key, and deriving it from the step-id namespace is guesswork.
   *
   * Deliberately NOT persisted on `Job`: that would put a column on every host
   * `JobStore` to serve bookkeeping the host can do in its own tables.
   * DESIGN: root-job-id-not-persisted
   */
  rootJobId?: string

  /** Optional host-parameterised project context. */
  project?: P
}

/**
 * Context surfaced to `AgentPattern.loop.system`. It is
 * `DispatchContext` minus `assets`: the system prompt is a **cached, byte-
 * stable prefix**, so it must never embed volatile resolved assets (those
 * flow through the cache-cold seed announcement instead). Authors
 * still read `providerOptions` / `sessionId` / `project` to shape the prompt.
 * DESIGN: system-prompt-no-assets
 */
export type SystemPromptContext<P = unknown> = Omit<DispatchContext<P>, 'assets'>

/**
 * Execution context surfaced to `MetaPattern.compose()`. An atomic Pattern
 * never receives this shape: its adapter gets the plain `DispatchContext`,
 * which carries no `step` (atomic is single-LLM by definition).
 *
 * Generic over host-attached session / project / workflow shapes so a host
 * can inject typed handles without breaking other consumers.
 * DESIGN: execution-context-meta-only
 */
export interface ExecutionContext<S = unknown, P = unknown, W = unknown>
  extends DispatchContext<P> {
  /**
   * Submit an async job through the runtime. Idempotency Layer 1 dedupes
   * against the canonical-hash key inside the store before dispatch.
   *
   * In meta.compose() use `ctx.step` instead — it adds id-keyed cache,
   * retry policy, and progress events on top of submitJob.
   *
   * Failure REJECTS here, unlike the host-facing `Runtime.submitJob`, which
   * resolves with the failed row. The two contracts differ on purpose: this
   * call runs inside a `compose()`, where a thrown error is what unwinds the
   * composition and carries CANCELLED through an abort cascade — exactly as
   * `ctx.step` does. A returned `cancelled` row would read as a settled
   * value to the code around it. The host boundary has no stack to unwind
   * and a `Job` to return; this one has the opposite.
   */
  submitJob<TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
  ): Promise<Job<TIn, TOut>>

  /** Dispatch a sub-Pattern with idempotency. */
  step: CtxStepFn

  /** Wrap a local fn with idempotency. */
  compute: CtxComputeFn

  /**
   * Pause mid-run to ask the user. A typed facade: `askUser.confirm/choose/form`
   * cover the three built-in interaction kinds with no payload guesswork, and
   * `askUser.custom` is the raw generic for anything outside them. Each parks in
   * place (compose's local
   * state is preserved) until the host's AskUserHandler returns — no replay /
   * idempotency, just a plain await on a human.
   */
  askUser: AskUser

  /** Position within a MetaPattern step list — folded into idempotency hash. */
  stepIndex: number

  // Optional domain-specific contexts; host parameterises ExecutionContext<S, P, W>.
  workflow?: W
  session?: S
}
