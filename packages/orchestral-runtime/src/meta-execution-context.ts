// MetaPattern.compose() — ExecutionContext construction.
//
// The runtime that owns meta dispatch (InlineRuntime) passes a `submitChild`
// callback so this module doesn't need to know the runtime class — keeps the
// dependency direction one-way (inline.ts depends on this, not vice versa).

import type {
  AskUserHandler,
  AskUserOptions,
  AskUserRequest,
  AssetNeed,
  CtxComputeFn,
  CtxStepFn,
  ExecutionContext,
  Job,
  JobSpec,
  PatternId,
  PatternRef,
  ResolvedAssetRef,
  RetryPolicy,
  StepOptions,
  StepResult,
} from '@orchestral/core'
import { buildAskUserFacade } from '@orchestral/core'
import { cancelledError } from './errors'

/**
 * Upper bound on a single run's ctx.compute cache. The cache is per dispatch
 * tree (a top-level meta and everything it fans out share one map), so it
 * normally holds a handful of entries — but a meta that fans a sub-meta out per
 * item (meta_storyboard dispatching meta_image-best-of-n once per panel) can
 * mint hundreds. Cap
 * it so one pathological run can't grow the map unbounded; evicting the oldest
 * entry on overflow is safe because a compute id is only re-hit from later in
 * the same compose, which keeps the live ones recent.
 */
const MAX_STEP_CACHE = 512

/**
 * Shared state across nested MetaPattern.compose() recursions.
 *
 * When meta-A calls `ctx.step({patternId: 'meta_B'})`, the runtime threads the
 * same `MetaSharedState` into meta-B's `buildMetaExecutionContext` so sibling
 * steps within meta-B can hit cached values produced inside meta-A (and vice
 * versa within one top-level dispatch). Top-level meta dispatches (no
 * inherited state) start with a fresh instance.
 *
 * Fields:
 *   • stepCache — **ctx.compute only**, keyed by the namespace-prefixed compute
 *     id, holding settled `{value, attempts, durationMs}` so a re-invocation
 *     with the same id short-circuits. ctx.step does not participate: its
 *     `stepIds` guard rejects a repeated stepId outright, so it has no repeat
 *     for a cache to answer, and letting it write anyway both filled
 *     MAX_STEP_CACHE with entries nothing reads and let a compute id shadow a
 *     later step of the same name. Sub-Pattern re-dispatch is deduped a layer
 *     down instead, by `deriveIdempotencyKey` + `JobStore.insertIfAbsent`,
 *     which is where the durable half of the idempotency contract actually
 *     lives.
 *   • askCounter — boxed counter for `ctx.askUser` correlation ids
 *     (`${rootJobId}:ask:${n}`); a box so nested ctx instances share one
 *     sequence. Ask ids only: a step's position is local to its compose (see
 *     ctx.step), so no park, and nothing a sibling does, moves a step's key.
 *   • stepIds — every effective (namespace-prefixed) stepId seen in the tree,
 *     default and explicit alike, for duplicate detection. Default ids repeat
 *     across composes, as explicit ones always could; the namespace is what
 *     makes an effective id tree-unique, so a collision this set catches is
 *     one inside a single compose — an explicit id that repeats, or one
 *     spelled like a default id the same compose produces.
 */
export interface MetaSharedState {
  stepCache: Map<
    string,
    { value: unknown; attempts: number; durationMs: number }
  >
  askCounter: { value: number }
  stepIds: Set<string>
  /**
   * jobId of the dispatch-tree ROOT — the top-level meta the LLM tool-called.
   * A host that surfaces dispatches in a UI typically has an element for that
   * root node only, not for the nested steps under it. Claimed once by the
   * first meta to use this state (top-level, or a fresh ctx.submitJob
   * escape-hatch subtree); every nested ctx.step inherits the same state, so
   * the same rootJobId. The ctx.askUser correlation id is prefixed with it so a
   * nested park still addresses the root, and the host can sweep every park
   * under one `${rootJobId}:` prefix. Uniqueness holds because rootJobId resets
   * exactly when the shared askCounter does: both live here, and a fresh state
   * claims a fresh root.
   */
  rootJobId?: string
}

/**
 * Dependencies the runtime injects so this module can dispatch sub-Patterns
 * and propagate the meta's ancestor chain + shared state. Keeps the runtime
 * class private — we don't import InlineRuntime here.
 *
 * They stay on the runtime's side of compose. The ExecutionContext built from
 * them hands a meta dispatch-by-id and nothing it could inspect or route with:
 * no registry and no router. The registry reads that do happen behind these
 * seams (`getAssetNeeds`, and the lookup inside `resolveStepReferences`) serve
 * the runtime's own guards, not the author — a meta names sub-Patterns, and
 * the runtime alone decides what they are and where they run.
 * DESIGN: compose-sees-no-registry
 */
export interface MetaCtxDeps {
  /**
   * Report a settled sub-step on the parent job's event stream. Optional so a
   * host driving `buildMetaExecutionContext` directly (tests, a custom meta
   * runner) needs no event plumbing; absent means the meta's sub-steps never
   * reach the parent's subscribers.
   */
  onStepSettled?: (args: {
    rootJobId: string
    stepId: string
    patternId: PatternId
    childJobId: string
    output: unknown
  }) => void
  /**
   * Dispatch a child Pattern. Maps to `InlineRuntime._submitJobInternal`
   * with the ancestor chain + meta shared state threaded through so nested
   * meta dispatches can inherit the parent's stepCache / askCounter / stepIds /
   * rootJobId.
   */
  submitChild: <TIn = unknown, TOut = unknown>(
    spec: JobSpec<TIn>,
    ancestors: readonly PatternId[],
    sharedState: MetaSharedState,
  ) => Promise<Job<TIn, TOut>>
  /**
   * Host seam to resolve a sub-step's LLM-facing `input.references`
   * handles against the meta's asset context (the ledger keyed by the meta
   * dispatch's sessionId). The runtime injects it from the
   * AgentAssetBridge in `dispatchMeta`; it resolves the target Pattern's
   * declared `assetNeeds` against the context and returns slot-keyed assetIds.
   *
   * Without this (library-only tests / bridge absent / no sessionId), `ctx.step`
   * leaves the handle channel unresolved exactly as before — only the internal
   * `ref.assets` channel feeds the child. With it, a meta that forwards a caller
   * handle to a sub-step (e.g. best-of-n's inner i2i `references.source`) gets
   * that handle resolved into the child's `DispatchContext.assets`, so the
   * adapter actually receives the source image.
   *
   * Fail-closed: throws on resolution failure (unknown handle / slot) so the
   * sub-step fails visibly rather than silently dispatching with no source.
   * Returns `[]` when the target declares no asset slots.
   *
   * `coveredSlots` names the slots the internal `ref.assets` channel already
   * fills for this step. The resolver must NOT apply its omitted-required-slot
   * default rule to those slots — the meta supplied the asset machine-to-machine,
   * and a "latest of modality" default would inject an unrelated ledger asset
   * next to (or ahead of) the intended one. Slots explicitly present in
   * `input.references` are unaffected: an explicit handle still resolves even
   * when the internal channel also covers the slot (the array-slot coexist
   * semantics below depend on that).
   */
  resolveStepReferences?: (
    patternId: PatternId,
    input: unknown,
    coveredSlots: ReadonlySet<string>,
  ) => readonly ResolvedAssetRef[]
  /**
   * Look up a child Pattern's declared asset slots (`registry.get(id).assetNeeds`).
   * Used solely to enforce the single-cardinality dual-source guard at the
   * channel merge below: if the SAME slot is filled by BOTH the handle-resolved
   * channel and the internal `ref.assets` channel and that slot is declared
   * single-cardinality, the single-slot consumer reads index [0] and would
   * silently pick whichever channel we ordered first — so we throw instead.
   * Absent (library-only tests, or a runtime without a registry seam) → the guard is
   * inert, which is safe because the handle channel is empty without a resolver,
   * so no dual-source clash can arise.
   */
  getAssetNeeds?: (patternId: PatternId) => readonly AssetNeed[]
  /** Host HITL seam (InlineRuntimeInit.askUser), threaded through dispatchMeta. */
  askUser?: AskUserHandler
}

/**
 * Abortable sleep used by retry backoff. Resolves after `ms` ms or rejects
 * with `CANCELLED` on signal abort — a cancel during backoff surfaces
 * immediately instead of after the delay has been slept out.
 *
 * Exported standalone because every retry-bearing code path shares the same
 * primitive: the meta ctx below and the atomic dispatch path's same-model
 * transient retry.
 */
export function abortableSleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError('aborted before the retry backoff started'))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(cancelledError('aborted during the retry backoff'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Backoff schedule for one `RetryPolicy`, shared by every retry loop in this
 * package so `{ kind: 'exponential', maxAttempts: 3 }` means the same number
 * of calls and the same waits wherever a host writes it.
 *
 * `attempt` is the 1-based attempt that just failed. Returns how long to wait
 * before the next one, or `null` when the policy has no attempts left — so
 * "are we done?" and "how long do we wait?" cannot drift apart at a call site.
 */
export function nextRetryDelayMs(
  policy: RetryPolicy,
  attempt: number,
): number | null {
  if (policy.kind === 'none') return null
  if (attempt >= policy.maxAttempts) return null
  return policy.kind === 'exponential'
    ? Math.min(
        policy.baseMs * 2 ** (attempt - 1),
        policy.maxMs ?? Number.POSITIVE_INFINITY,
      )
    : policy.delayMs
}

/**
 * Fail-loud guard for the two-channel asset merge (handle-resolved ∪ internal
 * `ref.assets`). A slot that is filled by BOTH channels is fine for an array
 * slot (best-of-n's judge stacks references ahead of candidates) but is a bug
 * for a single-cardinality slot: the consumer reads index [0] and would silently
 * take whichever channel we ordered first. Throw with a clear code instead.
 *
 * Only consults `getAssetNeeds` when both channels actually contribute — no
 * clash is possible otherwise. Absent seam / unknown cardinality → inert (the
 * array-style coexistence is preserved), which is safe because the handle
 * channel is empty without a resolver.
 * DESIGN: dual-source-single-slot
 */
function assertNoDualSourcedSingleSlot(
  patternId: PatternId,
  resolvedFromHandles: readonly ResolvedAssetRef[],
  internalAssets: readonly ResolvedAssetRef[],
  getAssetNeeds: MetaCtxDeps['getAssetNeeds'],
): void {
  if (resolvedFromHandles.length === 0 || internalAssets.length === 0) return
  const assetNeeds = getAssetNeeds?.(patternId) ?? []
  if (assetNeeds.length === 0) return
  const singleSlots = new Set(
    assetNeeds.filter((n) => n.cardinality === 'single').map((n) => n.slot),
  )
  if (singleSlots.size === 0) return
  const internalSlots = new Set(internalAssets.map((a) => a.slot))
  for (const r of resolvedFromHandles) {
    if (singleSlots.has(r.slot) && internalSlots.has(r.slot)) {
      throw Object.assign(
        new Error(
          `DUAL_SOURCE_SINGLE_SLOT: slot "${r.slot}" of pattern "${patternId}" ` +
            `received both a pinned internal asset and a resolved reference; a ` +
            `single-cardinality slot consumer reads index [0] and would silently ` +
            `pick the wrong asset.`,
        ),
        { code: 'DUAL_SOURCE_SINGLE_SLOT' },
      )
    }
  }
}

/**
 * ExecutionContext construction for MetaPattern.compose().
 *
 * ctx.compute is idempotent within a run through an in-memory cache; ctx.step
 * through the JobStore, keyed by the step's path (see `stepKey` below).
 * Persisting either across a process restart is the host's concern.
 *
 * `sharedState` carries `{stepCache, askCounter, stepIds, rootJobId}` from a
 * parent meta when this ctx is being built for a nested dispatchMeta.
 * Top-level meta dispatches construct a fresh state in `dispatchMeta` itself
 * and pass it in — this function never owns the lifecycle, only reads/mutates
 * through the provided handle. What is local to ONE compose — the ordinals of
 * its unnamed steps — lives in this closure instead.
 */
export function buildMetaExecutionContext(
  deps: MetaCtxDeps,
  metaId: PatternId,
  // The dispatched job id — stamped onto each AskUserRequest so the host can map
  // the park back to whatever surface it raised the dispatch from.
  jobId: string,
  spec: JobSpec<unknown>,
  signal: AbortSignal,
  visited: Set<PatternId>,
  sharedState: MetaSharedState,
  // When this ctx is built for a nested meta, the parent stamps
  // its launching step's effective stepId here (e.g. `panel-0`). Every stepId
  // this ctx mints — cache key + duplicate-detection set — gets prefixed with
  // it, so a child meta's ids — fixed explicit ones (best-of-n's `candidate-N`)
  // and default ones, which are numbered per compose — don't collide or
  // cross-contaminate when the same meta runs more than once in one dispatch
  // tree. The prefixed id is also each step's `stepKey`. Absent (top-level
  // meta) = no prefix.
  stepIdNamespace?: string,
): ExecutionContext {
  const { stepCache, askCounter, stepIds, rootJobId } = sharedState
  // Unnamed steps' ordinals, per pattern, for THIS compose only — see ctx.step.
  const ordinals = new Map<PatternId, number>()

  const runWithRetry = async <T,>(
    id: string,
    fn: () => Promise<T>,
    options: StepOptions | undefined,
    // Whether this call participates in `stepCache`. Only ctx.compute does.
    //
    // ctx.step cannot: the `stepIds` guard throws DUPLICATE_STEP_ID on a
    // repeated effective stepId *before* reaching here, so a step's cache read
    // can never hit its own prior write — the writes are dead, yet they still
    // consume MAX_STEP_CACHE and evict the compute entries that do get read.
    // Worse, the two share one key space while only ctx.step joins `stepIds`,
    // so `ctx.compute('seg-0', …)` followed by `ctx.step(ref, {stepId:'seg-0'})`
    // passed the duplicate guard and then returned the compute value: no
    // dispatch, no job:step event, no error. Keeping ctx.step out of the cache
    // entirely closes both.
    // DESIGN: ctx-step-skips-step-cache
    useCache = true,
  ): Promise<{ value: T; attempts: number; durationMs: number }> => {
    if (signal.aborted) throw cancelledError('aborted before the step ran')
    const cached = useCache ? stepCache.get(id) : undefined
    if (cached) {
      return cached as { value: T; attempts: number; durationMs: number }
    }
    const startTime = Date.now()
    const policy: RetryPolicy = options?.retry ?? { kind: 'none' }
    let attempt = 0
    // Loop attempts; rethrow on no-retry or exhausted maxAttempts.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) throw cancelledError('aborted between retry attempts')
      attempt++
      try {
        const value = await fn()
        const result = {
          value,
          attempts: attempt,
          durationMs: Date.now() - startTime,
        }
        if (useCache) {
          // Evict the oldest entry once the cache is full (Map iterates in
          // insertion order, so the first key is the oldest). Keeps a runaway
          // loop from growing the map without bound; the just-set entry stays.
          if (stepCache.size >= MAX_STEP_CACHE) {
            const oldest = stepCache.keys().next().value
            if (oldest !== undefined) stepCache.delete(oldest)
          }
          stepCache.set(id, result)
        }
        return result as { value: T; attempts: number; durationMs: number }
      } catch (err) {
        const delayMs = nextRetryDelayMs(policy, attempt)
        if (delayMs === null) throw err
        await abortableSleep(delayMs, signal)
      }
    }
  }

  // ctx.step: one sub-Pattern dispatch per call, and everything with an effect
  // a meta can ask of one — a PatternRef (id, input, internal assets) plus
  // StepOptions (retry, name, key). Everything else a step gets — the
  // dedup, the duplicate-id and cycle guards, the job:step event, the abort
  // cascade — the runtime supplies, whoever wrote the call.
  // DESIGN: ctx-step
  const stepCallable: CtxStepFn = Object.assign(
    async <T,>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      const result = await stepCallable.withMeta<T>(ref, options)
      return result.value
    },
    {
      withMeta: async <T,>(
        ref: PatternRef,
        options?: StepOptions,
      ): Promise<StepResult<T>> => {
        // A step's id is its name, or — unnamed — its position: the ordinal of
        // this call among this compose's unnamed calls to the same pattern.
        // The ordinal lives in this closure, not in the shared state, because
        // a counter shared by the tree is a function of timing: parallel
        // subtrees interleave on it, and a sibling that dedupes skips its
        // compose and the numbers it would have taken, so a step that had
        // succeeded drew a new number on the resubmit and was paid for again.
        // Counting only unnamed calls means naming or moving a named step never
        // renumbers one; counting per pattern means a call to another pattern
        // never does. Claimed here, at the call, before anything is awaited —
        // `parallel([...])` and an uncapped `parallel.limit` rely on that to
        // number in list order. Unnamed calls reached from concurrent branches
        // after an await take theirs in the order they are reached: name those.
        // DESIGN: default-step-id-is-positional
        let stepId: string
        if (options?.stepId !== undefined) {
          stepId = options.stepId
        } else {
          const n = ordinals.get(ref.patternId) ?? 0
          ordinals.set(ref.patternId, n + 1)
          stepId = `${ref.patternId}#${n}`
        }
        // Prefix with the launching step's effective id. Default ids are
        // numbered per compose, so they repeat across composes exactly as an
        // explicit `candidate-0` does; the prefix is what keeps every effective
        // id unique in the tree — and, since the effective id is the step's
        // durable key, what keeps two subtrees off each other's rows. Top-level
        // meta: no namespace, so effectiveStepId === stepId.
        const effectiveStepId = stepIdNamespace
          ? `${stepIdNamespace}/${stepId}`
          : stepId

        // One effective id per tree. An explicit id that repeats, or one that
        // lands on a default, is an authoring error: refused at the call,
        // before the step reusing it is submitted, rather than served twice —
        // though not before the steps that came earlier in compose have run.
        // DESIGN: duplicate-step-id
        if (stepIds.has(effectiveStepId)) {
          throw Object.assign(
            new Error(
              `DUPLICATE_STEP_ID: ${metaId} reused stepId '${effectiveStepId}' ` +
                `(likely an explicit options.stepId collided with another ` +
                `step within the same meta run — either de-duplicate the ` +
                `override or remove it to let framework auto-generate).`,
            ),
            { code: 'DUPLICATE_STEP_ID' },
          )
        }
        stepIds.add(effectiveStepId)

        // A step naming a pattern already on the ancestor chain would recurse
        // without bound. Refused at the call, before the child is submitted —
        // though not before the steps that came earlier in compose have run.
        // DESIGN: circular-meta-step
        if (visited.has(ref.patternId)) {
          throw Object.assign(
            new Error(
              `CIRCULAR_META_STEP: ${metaId} → ${ref.patternId} ` +
                `(ancestors: ${[...visited].join(' → ')})`,
            ),
            { code: 'CIRCULAR_META_STEP' },
          )
        }

        // A retry is this same step executing again, not an author reusing an
        // id: it re-dispatches the same path, and a meta child composes again
        // under the same namespace. The ids its failed attempt registered all
        // start with `${effectiveStepId}/`, so release them before the next
        // attempt — otherwise the retried compose trips DUPLICATE_STEP_ID on
        // its own first step instead of finding the rows that attempt banked.
        // This step's own id is not under the prefix and stays registered
        // once. The compute cache is left alone: computes the failed attempt
        // settled are reused, as the rows it banked are.
        let attempt = 0
        const run = async (): Promise<T> => {
          if (attempt++ > 0) {
            const prefix = `${effectiveStepId}/`
            for (const id of stepIds) if (id.startsWith(prefix)) stepIds.delete(id)
          }
          // Resolve the sub-step's LLM-facing `input.references` handles
          // against the meta's asset context (host seam). A meta forwarding a
          // caller handle to a sub-step (best-of-n's inner i2i references.source,
          // via-caption's source) had NO path to turn that handle into a
          // resolved assetId — only `ref.assets` (the meta's own products) ever
          // reached the child. Without this the adapter saw zero source images
          // and the i2i degraded to a text-only generation. Fail-closed: the
          // resolver throws on an unknown handle/slot, which fails this step
          // visibly rather than dispatching with no source.
          const internalAssets = ref.assets ?? []
          // Slots the internal channel covers are exempt from the resolver's
          // omitted-slot default rule (see the dep's JSDoc) — without this, a
          // meta feeding a required slot machine-to-machine would still get
          // the "latest of modality" ledger default merged in alongside.
          const coveredSlots: ReadonlySet<string> = new Set(
            internalAssets.map((a) => a.slot),
          )
          const resolvedFromHandles =
            deps.resolveStepReferences?.(ref.patternId, ref.input, coveredSlots) ?? []
          // Two channels feed the child: `resolvedFromHandles` (caller handles
          // the meta forwarded) and internal `ref.assets` (machine-to-machine
          // assetIds the meta produced). Both flow through — resolved handles
          // first, internal appended — and on a same-slot clash for an ARRAY
          // slot they COEXIST rather than one dropping the other. A multi-image
          // slot (image-to-text's `source`) then carries the caller's reference
          // images ahead of the meta's own, which is exactly what best-of-n's
          // judge needs: references labelled "Reference Image 0..M-1" before the
          // candidates. For a SINGLE-cardinality slot, dual-sourcing is a bug —
          // the consumer reads index [0] and would silently take whichever
          // channel we ordered first — so the guard below throws
          // (DUAL_SOURCE_SINGLE_SLOT) rather than relying on the coincidence
          // that no meta happens to pin ref.assets AND forward a handle onto the
          // same single slot.
          // DESIGN: step-asset-merge-order
          assertNoDualSourcedSingleSlot(
            ref.patternId,
            resolvedFromHandles,
            internalAssets,
            deps.getAssetNeeds,
          )
          const mergedAssets: ResolvedAssetRef[] = [
            ...resolvedFromHandles,
            ...internalAssets,
          ]
          // Pass sharedState into the child dispatch so a
          // nested meta inherits this run's stepCache / askCounter / stepIds.
          // Atomic / agent children ignore the param (it bottoms out in
          // dispatch.kind === 'meta' branch only).
          const child = await deps.submitChild<unknown, T>(
            {
              patternId: ref.patternId,
              // As the meta wrote it. Nothing on this path parses a step's
              // input against the child's `tool.inputs` — not here, not in
              // `_submitJobInternal` — so a meta that wants a schema default
              // applied applies it itself.
              // DESIGN: step-input-unparsed
              input: ref.input,
              // Internal-asset channel (PatternRef.assets) ∪ handle-channel
              // resolution: threads into the child's DispatchContext.assets (the
              // atomic dispatch path maps spec.assets → ctx.assets), and folds
              // into the child's idempotency hash (deriveIdempotencyKey hashes
              // spec.assets), so two steps fed different sources stay distinct.
              ...(mergedAssets.length > 0 ? { assets: mergedAssets } : {}),
              ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
              // A nested meta's sub-steps still resolve handles against
              // the ORIGINAL dispatch's ledger context (agent runId or chat
              // session); propagate so the chain never falls back to the wrong
              // namespace mid-tree.
              ...(spec.assetContextId ? { assetContextId: spec.assetContextId } : {}),
              // Hand the child meta this step's EFFECTIVE stepId
              // as its stepId namespace. A nested meta (e.g. one launched from
              // an outer meta's `step-0`) prefixes its internal stepIds with
              // `step-0`, and stamps `step-0/inner-0` onto ITS children —
              // the prefix grows by one segment per meta level, stays
              // deterministic across replays (the effective id is itself
              // deterministic), and never collides with a sibling subtree.
              // DESIGN: step-id-namespace-nesting
              stepIdNamespace: effectiveStepId,
              // One identity field reaches the child, always: the step's path,
              // the same string as `stepIdNamespace` above. `deriveIdempotencyKey`
              // hashes it, so a step finds its row run after run whatever ran
              // around it, and two subtrees running the same inner meta never
              // share one (`a/candidate-0` vs `b/candidate-0`).
              // DESIGN: step-identity-field
              stepKey: effectiveStepId,
              // The caller's own answer to "what is the same work", which
              // `_submitJobInternal` prefers over the derivation
              // DESIGN: caller-supplied-step-identity
              // (`spec.idempotencyKey ?? deriveIdempotencyKey(…)`). Spread
              // conditionally, so a step without one carries no
              // `idempotencyKey` field at all.
              //
              // `stepKey` above is still sent. With a caller key present it
              // keys nothing, but stripping it here would make the two options
              // interact when they are meant to be independent.
              ...(options?.idempotencyKey !== undefined
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
            },
            [...visited],
            sharedState,
          )
          // A child row that comes back `error`. Unreachable with a conforming
          // store: a fresh dispatch that fails throws out of `submitChild`
          // carrying its own code — that throw is what unwinds compose — and
          // dedup never hands back an errored row. Kept for a store that does.
          // DESIGN: meta-step-failed-unreachable
          if (child.status === 'error') {
            throw Object.assign(
              new Error(
                `META_STEP_FAILED: ${metaId} step[${effectiveStepId}] ` +
                  `${ref.patternId}: ${child.error?.message ?? 'unknown'}`,
              ),
              { code: 'META_STEP_FAILED' },
            )
          }
          // Announce on the parent's stream. Inside `run`, so it describes a
          // dispatch that actually happened and succeeded — exactly once per
          // step, since the stepIds guard above rejects a repeated id rather
          // than letting it reach the cache. `stepId` is the author-facing id,
          // matching StepResult.meta.stepId; the namespaced form is an
          // internal routing concern.
          if (rootJobId) {
            deps.onStepSettled?.({
              rootJobId,
              stepId,
              patternId: ref.patternId,
              childJobId: child.id,
              output: child.output,
            })
          }
          // The child's output, raw — what compose reads, and what a plan's
          // `$step.path` walks. No handle is minted for it (there is no
          // recordOutput on this path), and a dedup hit on a row still queued
          // or running hands back that row's null output, unawaited.
          // DESIGN: step-returns-raw-output
          return child.output as T
        }

        // Dedup key off the namespaced id so two subtrees never collide;
        // the StepResult.meta.stepId stays the author-facing id
        // (what they passed in options.stepId), since the namespace is an
        // internal routing concern, not part of their addressing contract.
        const { value, attempts, durationMs } = await runWithRetry<T>(
          effectiveStepId,
          run,
          options,
          // No cache: the stepIds guard above already rejected any repeat, so
          // there is nothing here for a cache to short-circuit. See the
          // `useCache` parameter.
          false,
        )
        return { value, meta: { stepId, attempts, durationMs } }
      },
    },
  )

  const compute: CtxComputeFn = async <T,>(
    id: string,
    fn: () => Promise<T>,
    options?: StepOptions,
  ): Promise<T> => {
    // Namespace the cache key exactly like ctx.step does. A
    // nested meta dispatched more than once in one tree (e.g. meta_storyboard
    // fans out meta_image-best-of-n per panel, each calling
    // ctx.compute('merge-final', …))
    // shares this run's stepCache. Without the prefix every item's compute
    // collides on the bare `merge-final` key → items 1..N return item 0's
    // cached value → silently corrupted output. compute does NOT go
    // through the stepIds dedup set (only ctx.step does), so the cache key is
    // the only thing to namespace. Top-level compute (stepIdNamespace
    // undefined) → cid === id, no prefix.
    const cid = stepIdNamespace ? `${stepIdNamespace}/${id}` : id
    const { value } = await runWithRetry<T>(cid, fn, options)
    return value
  }

  const askUserRaw = async <TPayload, TAnswer>(
    opts: AskUserOptions<TPayload, TAnswer>,
  ): Promise<TAnswer> => {
    if (signal.aborted) throw cancelledError('aborted before ctx.askUser parked')
    if (!deps.askUser) {
      throw Object.assign(
        new Error(
          `ASK_USER_NOT_SUPPORTED: ${metaId} called ctx.askUser but the runtime ` +
            `was constructed without an askUser handler.`,
        ),
        { code: 'ASK_USER_NOT_SUPPORTED' },
      )
    }
    // Prefix the correlation id with the dispatch-tree ROOT jobId (not this
    // meta's own), so a park from a NESTED meta still addresses the root and
    // the host can sweep every park under one `${rootJobId}:` prefix. The
    // number comes from the tree's ask counter, which nothing else reads: an
    // ask id has to be unique in the tree, and it is not work identity, so it
    // may depend on timing where a step's position may not. A park therefore
    // moves no step's key. A fresh escape-hatch subtree gets its own root and
    // counter, so ids never collide across trees. `request.jobId` is the root
    // too — the host routes/cleans by it. (`?? jobId`: dispatchMeta always
    // claims rootJobId before this runs; the fallback is belt-and-suspenders.)
    // DESIGN: ask-id-not-step-identity
    const root = rootJobId ?? jobId
    const request: AskUserRequest = {
      id: `${root}:ask:${askCounter.value++}`,
      kind: opts.kind,
      payload: opts.payload,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      jobId: root,
    }
    // Race the host promise against abort so cancel unwinds the park cleanly.
    const answer = await new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelledError('aborted before the ctx.askUser park was registered'))
        return
      }
      const onAbort = (): void =>
        reject(cancelledError('aborted while parked on ctx.askUser'))
      signal.addEventListener('abort', onAbort, { once: true })
      deps.askUser!(request).then(
        (a) => {
          signal.removeEventListener('abort', onAbort)
          resolve(a)
        },
        (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      )
    })
    return opts.answerSchema
      ? (opts.answerSchema.parse(answer) as TAnswer)
      : (answer as TAnswer)
  }

  return {
    // Escape hatch — usually authors should use ctx.step (which adds
    // idempotency, retry, audit). submitJob here threads the meta's
    // ancestor chain so even ad-hoc dispatches still get cycle / depth
    // detection. Routing it through the PUBLIC submitJob instead would seed
    // visited=[] and silently break A → B → A detection.
    //
    // Note: ctx.submitJob does NOT pass sharedState — escape hatch starts a
    // fresh meta-state root by design. Authors who want cache inheritance
    // use ctx.step. Nor does it announce itself: job:step is fired from
    // ctx.step's own run, so a child submitted here never reaches this meta's
    // stream.
    // DESIGN: submit-job-escape-hatch
    submitJob: <TIn = unknown, TOut = unknown>(s: JobSpec<TIn>) =>
      deps.submitChild<TIn, TOut>(s, [...visited], makeFreshState()),
    step: stepCallable,
    compute,
    // Generic raw bridge (mint id + raceAbort + answerSchema.parse) wrapped in
    // the typed facade: ctx.askUser.confirm/choose/form + .custom (= the raw).
    askUser: buildAskUserFacade(askUserRaw),
    signal,
    // AssetLedger resolution pass: the host pre-resolved this into
    // spec.assets; meta.compose reads it via ctx.assets.
    assets: spec.assets ?? [],
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
  }
}

/**
 * Convenience: produce a fresh MetaSharedState. Used by `dispatchMeta` when
 * starting a top-level meta run (no inherited state), and by ctx.submitJob
 * escape hatch (intentionally independent sub-tree).
 */
export function makeFreshState(): MetaSharedState {
  return {
    stepCache: new Map(),
    askCounter: { value: 0 },
    stepIds: new Set(),
  }
}
