// ExecutionContext — the dispatch context plus the step/compute primitives.
//
// Model execution belongs to the host CapabilityRouter, so the only
// host-callable escape hatch on the base context is submitJob. MetaPattern
// composition adds ctx.step / ctx.compute on top: sub-Pattern dispatch and
// idempotent local-fn wrapping, each with retry and abort.

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
 * DESIGN: retry-policy
 */
export type RetryPolicy =
  | { kind: 'none' }
  | { kind: 'exponential'; maxAttempts: number; baseMs: number; maxMs?: number }
  | { kind: 'fixed'; maxAttempts: number; delayMs: number }

// Everything with an effect a caller can ask of one `ctx.step` beyond the
// PatternRef: how to retry it, what to call it — which is also what keys its
// durable row — and a key of the caller's own. None of it changes what the
// step dispatches — only how it is retried, named and deduped.
// DESIGN: step-options
export interface StepOptions {
  /** Retry policy; default `{ kind: 'none' }`. */
  retry?: RetryPolicy
  /**
   * Name this step. The name keys the step's durable JobStore row, prefixed by
   * the ids of the steps that launched this compose, so adding, removing or
   * reordering other steps in this compose never re-keys it. It moves only if
   * a step that launched this compose is renumbered, so name that one too.
   *
   * Unnamed, the id is `${patternId}#${n}` (a `/` in the pattern id is
   * written `%2F`): n counts the unnamed calls to the same pattern this
   * compose made before this one. Inserting a named step, or
   * an unnamed call to another pattern, leaves it alone; inserting an unnamed
   * call to the same pattern ahead of it renumbers it, and a renumbered step
   * runs again. N identical unnamed dispatches are still N rows.
   *
   * The number is taken when `ctx.step` is called. Calls made in order —
   * sequential awaits, `parallel([...])` over calls written inline, an
   * uncapped `parallel.limit` — number in that order. Calls reached from
   * concurrent branches after an `await` — inside capped `parallel.limit`
   * tasks, or `parallel(items.map(async (x) => { await …; ctx.step(…) }))` —
   * number in the order they are reached, which can differ between runs.
   * Name those (`candidate-${i}`), or a resubmit pays for them again — never
   * with another step's output, since the input is in the key too.
   *
   * A name is unique within its compose: a repeat, or a name spelled like a
   * default id that this compose also produces, throws `DUPLICATE_STEP_ID`.
   * It may not contain `/`, which separates the ids in a step's path: that
   * throws `STEP_ID_RESERVED_CHARACTER`, as a `ctx.compute` id carrying one
   * does.
   */
  stepId?: string

  /**
   * Key this step's durable row on a string the CALLER derives, bypassing
   * `deriveIdempotencyKey` entirely — the same override `JobSpec.idempotencyKey`
   * has always given a host submitting directly, reachable from inside a
   * `compose` where the framework, not the author, builds the child spec.
   *
   * Why naming the step is not enough. The derivation hashes `sessionId` —
   * "dedup never crosses a session boundary" is a deliberate property of it,
   * not an oversight. So a caller whose notion of "the same work" is broader
   * than one session cannot express it through the step's name: a named step
   * survives an edit to the other steps in its compose (unless an unnamed
   * step that launched the compose is renumbered), and still re-pays in a
   * new session.
   * Content-addressed reuse that outlives the conversation the request arrived
   * in is a key question, and this is where a caller answers it.
   *
   * When present, the step's path stops mattering for the durable key: it is
   * an input to a derivation that no longer runs. The name still governs
   * everything else (which id the step reports, how a nested meta's namespace
   * composes), so a step may sensibly pass both.
   *
   * Almost the whole burden moves with the key. The engine stops asking
   * whether the input changed, so a key that omits something the step actually
   * reads hands back the earlier output for later work — within one pattern
   * that is a stale-but-valid result, not an error, and the caller is the only
   * one who can tell it is wrong.
   *
   * The one collision the runtime still refuses is a key already held by a row
   * for a DIFFERENT pattern: `IDEMPOTENCY_KEY_CROSS_PATTERN`. That row's output
   * was gated against the other pattern's `outputs` schema and never against
   * this one's, so handing it back is not a stale answer to this question but
   * an answer to a different one. Only a caller-supplied key can produce it —
   * the derivation hashes `patternId`.
   *
   * So: derive it from everything the step depends on, and include the pattern.
   */
  idempotencyKey?: string
}

// What `ctx.step.withMeta` reports about a step: its author-facing id, how many
// attempts it took, how long. No child job id — that stays on the runtime's
// side of compose, and a host that needs one reads it off `job:step`.
// DESIGN: step-meta-no-child-job-id
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

  // Optional domain-specific contexts; host parameterises ExecutionContext<S, P, W>.
  workflow?: W
  session?: S
}
