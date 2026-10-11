// The reserved `name` input field of an asset-producing Pattern, and the two
// reads everything else shares: what name an input carries (productNameOf) and
// whether a Pattern gets the field at all (producesAssets). The argument for
// the field is on PRODUCT_NAME_FIELD.
import { z } from 'zod'

import { parseMintedHandle } from './asset-index'
import { fromAssetUri } from './asset-uri'
import { markDerived } from './derived-fields'
import { ASSET_KINDS } from './output-fields'
import type { Pattern } from './pattern'

const NAME_MAX_LENGTH = 64

// Model-visible copy: it enters the tool schema of every asset-producing
// Pattern, so an edit invalidates every cached prefix that renders one.
const NAME_DESCRIBE =
  'Optional handle for what this call produces, bound now rather than assigned on completion — one asset is named exactly this, several are named <name>-1, <name>-2, … in output order — so later references can use it instead of a handle guessed from call order. It must not already be in use in this context and must not look like a generated handle (image_3, video_1).'

/** The trimmed, URI-normalised name, or undefined when blank. Pure. */
function normaliseName(raw: string): string | undefined {
  const name = fromAssetUri(raw.trim()).trim()
  return name === '' ? undefined : name
}

/** True when `name` is something the ledger could mint for SOME kind. */
function looksMinted(name: string): boolean {
  return ASSET_KINDS.some((kind) => parseMintedHandle(name, kind) !== undefined)
}

/**
 * `name` — what the product of this call is called, chosen by the caller and
 * bound for the dispatch instead of minted when the result is recorded.
 *
 * A minted handle is dense and guessable: `image_N` is assigned in completion
 * order, so a model that writes `image_4` from its own call order lands on a
 * real image — the wrong one — and nothing fails. A name bound before the work
 * runs turns a reference the model did not copy into a miss (HANDLE_NOT_FOUND)
 * instead of a neighbour.
 *
 * Minted and chosen names live in disjoint grammars, and that is the refusal
 * here: a name in any kind's mint grammar (`image_3`, `video_1`) is rejected,
 * judged after the same normalisation productNameOf applies, so neither
 * `asset://image_3` nor ` image_3 ` slips through. The ledger reads a supplied
 * `image_3` as a replay of its own mint and pulls its counter up to it (see
 * mintNext), so a chosen one would steer every later mint in the context, and
 * one in another kind's grammar would collide with a mint that has not
 * happened yet. The grammar is parseMintedHandle's, asked over ASSET_KINDS —
 * the ledger's own inverse, not a second list of kinds. Charset is otherwise
 * free (CJK is fine); 64 characters keeps the suffixed `<name>-<n>` inside
 * assetIdField's bound for handles.
 * DESIGN: model-named-handle
 */
export const PRODUCT_NAME_FIELD = markDerived(
  z
    .string()
    .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters.`)
    .refine(
      (raw) => {
        const name = normaliseName(raw)
        return name === undefined || !looksMinted(name)
      },
      {
        message:
          'name must not have the shape of a generated handle (<kind>_<n>, e.g. image_3): those are assigned by the ledger. Pick another name, or omit name.',
      },
    )
    .describe(NAME_DESCRIBE)
    .optional(),
)

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

/**
 * Whether a Pattern's outputs declare an `assets` property — the only place a
 * produced asset is recorded from. Reads `outputs.shape` (the same
 * introspection find_pattern's summary does); false for an agent without
 * `outputs` (the registry backfills the default finish outputs, which declare
 * `assets`, before it asks) and for a non-object outputs root.
 */
export function producesAssets(pattern: Pattern): boolean {
  const shape = (pattern.outputs as { shape?: unknown } | undefined)?.shape
  return typeof shape === 'object' && shape !== null && Object.hasOwn(shape, 'assets')
}
