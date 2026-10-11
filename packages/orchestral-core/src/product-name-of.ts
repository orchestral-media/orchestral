// What product name a dispatch input carries: the pure string half of the
// reserved `name` field, apart from the zod field that refuses a bad one.
//
// A leaf, importing only the asset-URI writing form. The ledger reads a name
// here (resolveAssetReferences' HANDLE_TAKEN check), and product-name.ts asks
// the ledger's parseMintedHandle for the field's refusal; with the reader in a
// module of its own, each depends on this one and neither on the other. It also
// keeps the ledger — which InMemoryAssetStore, on @orchestral/core/memory,
// loads — from loading zod and building the field just to read a string.
import { fromAssetUri } from './asset-uri'

/**
 * Internal. The trimmed, URI-normalised name, or undefined when blank. Pure.
 * The one normalisation: productNameOf reads a name through it, and the `name`
 * field judges the mint grammar on what it returns.
 */
export function normaliseName(raw: string): string | undefined {
  const name = fromAssetUri(raw.trim()).trim()
  return name === '' ? undefined : name
}

/**
 * The product name a dispatch input carries: `input.name`, trimmed, with the
 * asset-URI writing form normalised (`asset://hero` → `hero`), and blank read
 * as absent — the same rule a blank optional slot gets. Undefined for a
 * non-object input or a non-string `name`. The one reader of the name: the
 * resolver, the runtime and a host's chat path all call this, never
 * `input.name` directly.
 */
export function productNameOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = (input as { name?: unknown }).name
  return typeof raw === 'string' ? normaliseName(raw) : undefined
}
