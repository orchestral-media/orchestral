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

/**
 * Upper bound on a single run's stepCache. The cache is per dispatch tree (a
 * top-level meta and everything it fans out share one map), so it normally
 * holds a handful of steps — but a meta that fans a sub-meta out per item
 * (meta_idea2video dispatching meta_script2video once per scene) can mint
 * hundreds of cache entries. Cap
 * it so one pathological run can't grow the map unbounded; evicting the oldest
 * entry on overflow is safe because resume/idempotency only needs steps still
 * referenced later in the same compose, which are the most recent ones.
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
 *   • stepCache — keyed by the effective (namespace-prefixed) stepId, holds
 *     settled `{value, attempts, durationMs}` of completed steps so a
 *     re-invocation with the same stepId short-circuits (the resume/idempotency
 *     contract). ctx.compute keys are prefixed the same way.
 *   • stepCounter — boxed mutable counter for default stepId generation
 *     (`${patternId}#${counter}`); a box rather than a number primitive so
 *     nested ctx instances share the same monotonic sequence.
 *   • stepIds — set of every stepId seen (default + explicit override) for
 *     duplicate detection — an explicit override and an auto-generated id
 *     cannot collide silently; the framework throws on conflict.
 */
export interface MetaSharedState {
  stepCache: Map<
    string,
    { value: unknown; attempts: number; durationMs: number }
  >
  stepCounter: { value: number }
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
   * exactly when the shared stepCounter does (both live here).
   */
  rootJobId?: string
}

/**
 * Dependencies the runtime injects so this module can dispatch sub-Patterns
 * and propagate the meta's ancestor chain + shared state. Keeps the runtime
 * class private — we don't import InlineRuntime here.
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
   * meta dispatches can inherit the parent's stepCache / counter / stepIds.
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
      reject(new Error('CANCELLED'))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('CANCELLED'))
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
 * ctx.step / ctx.compute both achieve idempotency via an in-memory per-run
 * cache. Persisting step runs across process restarts is a host concern; this
 * layer provides only the in-memory version, and a host can swap in its own
 * store backend on top.
 *
 * `sharedState` carries `{stepCache, stepCounter, stepIds}`
 * from a parent meta when this ctx is being built for a nested dispatchMeta.
 * Top-level meta dispatches construct a fresh state in `dispatchMeta` itself
 * and pass it in — this function never owns the lifecycle, only reads/mutates
 * through the provided handle.
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
  // it, so a child meta's fixed explicit stepIds (best-of-n's `candidate-N`)
  // don't collide / cross-contaminate when the same meta runs more than once
  // in one dispatch tree. Absent (top-level meta) = no prefix.
  stepIdNamespace?: string,
): ExecutionContext {
  const { stepCache, stepCounter, stepIds, rootJobId } = sharedState

  const runWithRetry = async <T,>(
    id: string,
    fn: () => Promise<T>,
    options: StepOptions | undefined,
  ): Promise<{ value: T; attempts: number; durationMs: number }> => {
    if (signal.aborted) throw new Error('CANCELLED')
    const cached = stepCache.get(id)
    if (cached) {
      return cached as { value: T; attempts: number; durationMs: number }
    }
    const startTime = Date.now()
    const policy: RetryPolicy = options?.retry ?? { kind: 'none' }
    let attempt = 0
    // Loop attempts; rethrow on no-retry or exhausted maxAttempts.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) throw new Error('CANCELLED')
      attempt++
      try {
        const value = await fn()
        const result = {
          value,
          attempts: attempt,
          durationMs: Date.now() - startTime,
        }
        // Evict the oldest entry once the cache is full (Map iterates in
        // insertion order, so the first key is the oldest). Keeps a runaway
        // loop from growing the map without bound; the just-set entry stays.
        if (stepCache.size >= MAX_STEP_CACHE) {
          const oldest = stepCache.keys().next().value
          if (oldest !== undefined) stepCache.delete(oldest)
        }
        stepCache.set(id, result)
        return result as { value: T; attempts: number; durationMs: number }
      } catch (err) {
        const delayMs = nextRetryDelayMs(policy, attempt)
        if (delayMs === null) throw err
        await abortableSleep(delayMs, signal)
      }
    }
  }

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
        // Default stepId is a sequential counter — a deliberately simple form:
        // production Patterns are write-once, so the author owns the fact that
        // reordering code invalidates resume. Both default-generated and
        // explicit `options.stepId` go through the same stepIds set so the
        // framework can flag collisions — defence-in-depth against author typo.
        //
        // Compute the index once so stepId / stepIndex / counter advance
        // atomically. Counter is shared across nested metas via sharedState
        // — siblings of meta-A and meta-B see one monotonic sequence.
        const idx = stepCounter.value++
        // stepId differentiates on patternId only.
        const stepId = options?.stepId ?? `${ref.patternId}#${idx}`
        // Namespace the stepId by the parent's launching step.
        // The shared stepCounter already keeps DEFAULT ids (`patternId#idx`)
        // tree-unique, so only EXPLICIT ids (best-of-n's `candidate-N`) can
        // collide when the same meta runs twice in one tree. Prefixing both the
        // dedup set and the cache key with the parent step's effective id makes
        // `candidate-0` under `panel-0` distinct from the one under `panel-1`,
        // and the child stamps `effectiveStepId` onto its OWN children so the
        // namespace nests deterministically at any depth. Top-level meta:
        // stepIdNamespace is undefined → effectiveStepId === stepId, so no
        // prefix is applied.
        const effectiveStepId = stepIdNamespace
          ? `${stepIdNamespace}/${stepId}`
          : stepId

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

        if (visited.has(ref.patternId)) {
          throw Object.assign(
            new Error(
              `CIRCULAR_META_STEP: ${metaId} → ${ref.patternId} ` +
                `(ancestors: ${[...visited].join(' → ')})`,
            ),
            { code: 'CIRCULAR_META_STEP' },
          )
        }

        const run = async (): Promise<T> => {
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
          // nested meta inherits this run's stepCache / counter / stepIds.
          // Atomic / agent children ignore the param (it bottoms out in
          // dispatch.kind === 'meta' branch only).
          const child = await deps.submitChild<unknown, T>(
            {
              patternId: ref.patternId,
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
              stepIdNamespace: effectiveStepId,
              stepIndex: idx,
            },
            [...visited],
            sharedState,
          )
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
          return child.output as T
        }

        // Cache + dedup key off the namespaced id so two subtrees never share
        // a cache slot; the StepResult.meta.stepId stays the author-facing id
        // (what they passed in options.stepId), since the namespace is an
        // internal routing concern, not part of their addressing contract.
        const { value, attempts, durationMs } = await runWithRetry<T>(
          effectiveStepId,
          run,
          options,
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
    // nested meta dispatched more than once in one tree (e.g. meta_idea2video
    // fans out meta_script2video per scene, each calling
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
    if (signal.aborted) throw new Error('CANCELLED')
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
    // shared stepCounter (same one ctx.step uses for default stepIds) keeps ids
    // unique within the tree; a fresh escape-hatch subtree gets its own root +
    // counter, so no cross-tree collision. `request.jobId` is the root too — the
    // host routes/cleans by it, unchanged. (`?? jobId`: dispatchMeta always
    // claims rootJobId before this runs; the fallback is belt-and-suspenders.)
    const root = rootJobId ?? jobId
    const request: AskUserRequest = {
      id: `${root}:ask:${stepCounter.value++}`,
      kind: opts.kind,
      payload: opts.payload,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      jobId: root,
    }
    // Race the host promise against abort so cancel unwinds the park cleanly.
    const answer = await new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('CANCELLED'))
        return
      }
      const onAbort = (): void => reject(new Error('CANCELLED'))
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
    // use ctx.step.
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
    stepIndex: 0,
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
    stepCounter: { value: 0 },
    stepIds: new Set(),
  }
}
