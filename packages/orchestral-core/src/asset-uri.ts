// The URI writing form of an AssetLedger reference: `<scheme>//<handle>` in
// prose or tool arguments is equivalent to a bare handle, and the resolver
// normalizes it via fromAssetUri. The URI carries only the handle segment —
// never an assetId / projectId / sessionId (the ledger indirection invariant);
// whatever protocol a host uses to fetch the actual bytes is a separate
// concern, don't conflate the two.

const DEFAULT_SCHEME = 'asset://'
const SCHEME_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/$/i

let scheme: string = DEFAULT_SCHEME

/**
 * Overrides the scheme this module encodes and recognizes. A host calls it once
 * per process, before anything encodes or decodes a URI — the scheme is a
 * host-wide constant, so a single module-level setting keeps every call site
 * (`toAssetUri` / `isAssetUri` / `fromAssetUri`) parameter-free.
 *
 * Idempotent in the sense that calling it repeatedly is harmless and the last
 * call wins; it is not versioned or scoped, so a host must not switch schemes
 * while URIs minted under the previous one are still in flight. Omitting the
 * call entirely leaves the neutral `asset://` default in place.
 *
 * @param next - Full scheme prefix including the `://` separator, e.g. `my://`.
 * @throws If `next` is not a well-formed `<scheme>://` prefix. A bare word
 * would make `isAssetUri` match plain handles that merely start with it.
 * @alpha
 */
export function setAssetUriScheme(next: string): void {
  if (!SCHEME_SHAPE.test(next)) {
    throw new Error(`asset uri scheme must look like "name://", got: ${JSON.stringify(next)}`)
  }
  scheme = next
}

export function toAssetUri(handle: string): string {
  return `${scheme}${encodeURIComponent(handle)}`
}

export function isAssetUri(ref: string): boolean {
  return ref.startsWith(scheme)
}

/** Strips the scheme and decodes; a non-URI is returned as-is. On a decode
 *  failure it returns the still-encoded remainder — a lookup miss then falls
 *  naturally into the structured HANDLE_NOT_FOUND self-correction path. */
export function fromAssetUri(ref: string): string {
  if (!isAssetUri(ref)) return ref
  const rest = ref.slice(scheme.length)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}
