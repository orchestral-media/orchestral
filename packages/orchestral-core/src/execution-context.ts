// ExecutionContext — simplified context plus the step/compute primitives.
//
// History:
//   Early versions surfaced callCapability + resolveModel on the context.
//   Execution moved to the host CapabilityRouter, so the only host-callable
//   remaining was submitJob.
//   ctx.step / ctx.compute were then added for MetaPattern.compose() —
//   sub-Pattern dispatch + idempotent local-fn wrapping, with retry / abort /
//   metadata, replacing the earlier static `MetaPlan` data shape.

import type { ResolvedAssetRef } from './asset-index.types'
import type { Job, JobSpec } from './job'
import type { PatternRef } from './pattern-ref'
import type { ZodSchema } from './foundational'
import type { AskUserRequest, AskUserKind } from './pause'
import type { AskUser } from './ask-user'

/**
 * Tracing surface (OTel-shaped). Declaration only: the default runtime never
 * starts a span. Inject a Tracer and call it from your own compose() / host
 * code, backed by whatever exporter you use.
 *
 * @alpha
 */
export interface Span {
  setAttribute(key: string, value: unknown): void
  setStatus(status: 'ok' | 'error', message?: string): void
  end(): void
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, unknown>): Span
}

/**
 * BudgetGuard — a host-injected spend ceiling, trimmed to "consume + ask" so an
 * implementation can be a counter or a no-op.
 *
 * Declaration only through 0.1.x: the default runtime never calls consume(),
 * remaining(), or throwIfExceeded(). Nothing is metered unless your own
 * compose() / host code calls it.
 *
 * @alpha
 */
export interface BudgetGuard {
  consume(usd: number): Promise<void>
  remaining(): Promise<{ usd: number; jobs: number } | null>
  /** Throw early if the budget would be exhausted by the next consume(). */
  throwIfExceeded(): Promise<void>
}

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
  /** Free-form observability metadata flows into workflow.json + tracer. */
  metadata?: Record<string, unknown>
  /**
   * Override the auto-generated stepId. Default = `${patternId}#${seq}`
   * where seq is the order of the call within this compose run. Use
   * explicit override for fan-out (`portrait-${i}`) where deterministic
   * order is needed for resume.
   */
  stepId?: string
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
 * Available inside `MetaPattern.compose()`. Atomic `primary.execute` is
 * restricted to a single LLM call and must NOT use `ctx.step`
 * — multi-step fallback goes through declarative `alternatives` → meta.
 *
 * Defaults to plain value return; use `.withMeta()` to get the full
 * `{ value, meta }` shape when stepId / attempts / latency is needed for
 * progress UI or debug.
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
 * Current state: the atomic adapter's `ModelCapability.call(input, ctx)`
 * already receives `DispatchContext` (constructed in the runtime's
 * dispatchAtomic); meta `compose` / agent `loop.system` also consume ctx.
 * Wiring the host's population of `assets` / `project` / `providerOptions`
 * is a follow-up.
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

  /** Optional host-parameterised project context. */
  project?: P
}

/**
 * Context surfaced to `AgentPattern.loop.system`. It is
 * `DispatchContext` minus `assets`: the system prompt is a **cached, byte-
 * stable prefix**, so it must never embed volatile resolved assets (those
 * flow through the cache-cold seed announcement instead). Authors
 * still read `providerOptions` / `sessionId` / `project` to shape the prompt.
 */
export type SystemPromptContext<P = unknown> = Omit<DispatchContext<P>, 'assets'>

/**
 * Execution context surfaced to `MetaPattern.compose()`. AtomicPattern
 * `primary.execute` receives the host's own input/bindings/ctx triple —
 * its ctx may include `submitJob` but **must not** include `step` (atomic
 * is single-LLM by definition).
 *
 * Generic over host-attached session / project / workflow shapes so a host
 * can inject typed handles without breaking other consumers.
 */
export interface ExecutionContext<S = unknown, P = unknown, W = unknown>
  extends DispatchContext<P> {
  /**
   * Submit an async job through the runtime. Idempotency Layer 1 dedupes
   * against the canonical-hash key inside the store before dispatch.
   *
   * In meta.compose() use `ctx.step` instead — it adds id-keyed cache,
   * retry policy, and progress events on top of submitJob.
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

  budget?: BudgetGuard
  tracer?: Tracer

  /** Position within a MetaPattern step list — folded into idempotency hash. */
  stepIndex: number

  // Optional domain-specific contexts; host parameterises ExecutionContext<S, P, W>.
  workflow?: W
  session?: S
}
