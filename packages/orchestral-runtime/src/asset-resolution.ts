// Runtime resolution seam. Combines buildAssetIndex + resolveAssetReferences
// into a single dispatch-time entry point: the host supplies AssetEvent[] plus
// a Pattern's assetNeeds plus the LLM input, and this resolves the real assetId
// (landing in ctx.assets) or a structured fail-closed error.
//
// This seam is a pure, testable function; live-wiring it into dispatch and
// mapping errors to tool-results happens at the host wiring layer.
import {
  buildAssetIndex,
  resolveAssetReferences,
  type AssetEvent,
  type AssetNeed,
  type AssetResolutionError,
  type ResolvedAssetRef,
} from '@orchestral/core'

/**
 * `input` is forwarded to resolveAssetReferences untouched, so it is typed as
 * that function's own: a dispatch input's `name` reaches the HANDLE_TAKEN
 * check, and a narrower type here would forbid what the call can refuse.
 * @alpha
 */
export function resolveAssets(
  input: Parameters<typeof resolveAssetReferences>[0],
  assetNeeds: ReadonlyArray<AssetNeed>,
  events: ReadonlyArray<AssetEvent>,
):
  | { ok: true; assets: ReadonlyArray<ResolvedAssetRef> }
  | { ok: false; error: AssetResolutionError } {
  return resolveAssetReferences(input, assetNeeds, buildAssetIndex(events))
}
