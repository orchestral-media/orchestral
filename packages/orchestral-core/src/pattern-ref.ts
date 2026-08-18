import type { PatternId } from './foundational'
import type { ResolvedAssetRef } from './asset-index.types'

/**
 * Reference shape used by MetaPattern.compose() (and by alternatives that
 * delegate to a Pattern) to point at another Pattern + input bundle.
 *
 * Host-injected ambient context (projectId / providerOptions) is NOT carried
 * here — it flows through the dispatch `ctx`; a ref only names the
 * target Pattern + the LLM-authored input.
 *
 * A meta MAY, however, pass already-resolved asset refs to a sub-step via the
 * `assets` field. This is the deliberate internal-asset channel: assetId-keyed,
 * machine-to-machine flow between a meta and its children. It bypasses the
 * handle layer entirely — the meta produced these assetIds itself (from a prior
 * sub-step's output) and threads them straight into the child's
 * `DispatchContext.assets`, the same slot-keyed shape the host's resolution
 * pass produces for top-level dispatches. The LLM never sees these assetIds;
 * `input.references` (handles) remains the only LLM-facing asset channel.
 *
 * Capability sub-modes are expressed via `input.providerOptions` (typed
 * schema, derived per-model) and `input.references` asset slots — meta
 * compose passes those in `input` directly.
 */
export interface PatternRef {
  patternId: PatternId
  input: unknown
  /**
   * Internal-asset channel (machine-to-machine): pre-resolved, slot-keyed
   * assetIds a meta passes to this sub-step. Threaded into the child JobSpec's
   * `assets` → `DispatchContext.assets`, consumed by the adapter via
   * `assetsForSlot`. Omit when the sub-step needs no meta-supplied source.
   */
  assets?: readonly ResolvedAssetRef[]
}
