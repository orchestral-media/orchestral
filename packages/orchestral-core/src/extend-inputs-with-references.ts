// The reserved top-level input keys, placed by one rule.
//
// `references` (from a Pattern's assetNeeds) and `name` (for a Pattern whose
// outputs carry assets[]) are derived, never authored. The rule that places
// them is placeReserved, and it has two callers: extendInputsWithReferences,
// which a factory runs at construction so something reading the inputs before
// registration sees the field, and completeToolInputs, which register() runs on
// every Pattern. One helper, so the factory and the registry cannot disagree
// about what an author may write.
import { z } from 'zod'

import type { AssetNeed } from './asset-index.types'
import { deriveReferencesSchema } from './derive-references-schema'
import { isDerived, type ReservedInputKey } from './derived-fields'
import type { ZodSchema } from './foundational'
import type { Pattern } from './pattern'
import { PRODUCT_NAME_FIELD, producesAssets } from './product-name'

/**
 * SSOT injection: extend a Pattern's tool input schema with the
 * assetNeeds-derived `references` field, for a factory whose inputs something
 * reads before registration. AtomicPattern's constructor calls this; MetaPattern
 * factories (plain object literals, no ctor to hook) call it directly at
 * construction. Registration derives the field again from the Pattern's own
 * assetNeeds whether or not this ran, so it is never the only derivation.
 * Dispatch validates the extended BASE schema; find_pattern renders an
 * LLM-facing derivation of it (providerOptions lift) through which the
 * references field passes byte-identically — and dispatch-pattern.ts applies
 * .passthrough() at the TOP level only, so nested strictness survives.
 * Schema-shown and schema-enforced agree on references.
 *
 * Returns `inputs` unchanged (same reference), inspecting nothing, when the
 * Pattern declares no asset slots: construction does not judge that case,
 * registration does. Otherwise `references` is a reserved key under the rule
 * registration applies: absent, the derived field is appended after the
 * declared shape; a field an earlier derivation placed there is replaced in
 * place, keeping its position; anything else is hand-written and throws
 * INPUT_RESERVED_KEY. Deterministic — byte-stable for identical (inputs,
 * assetNeeds). Object-level describe/meta on the base survives (re-attached
 * after safeExtend, minus the registry id).
 *
 * Throws EXTEND_REFERENCES_UNSUPPORTED_INPUTS when asset slots are declared but
 * inputs is not a ZodObject (construction-time author error — fail fast rather
 * than silently skipping the injection).
 */
export function extendInputsWithReferences<I>(
  patternId: string,
  inputs: ZodSchema<I>,
  assetNeeds: ReadonlyArray<AssetNeed> | undefined,
): ZodSchema<I> {
  const derivedRefs = deriveReferencesSchema(assetNeeds)
  if (!derivedRefs) return inputs
  // Cast: I is the base input type; the extended schema parses {…I,
  // references?} at runtime. Dispatch reads parsed input as
  // Record<string, unknown>, so typed callers aren't relying on I including
  // references — the narrower static type is a safe lie here.
  return placeReserved(
    patternId,
    inputs as ZodSchema<unknown>,
    'references',
    derivedRefs,
  ) as unknown as ZodSchema<I>
}

/**
 * Internal; called only by `PatternRegistry.register`. Derive both reserved keys
 * onto a Pattern's LLM-facing tool inputs — `references` from its own
 * assetNeeds, then `name` when its outputs carry assets[] — and return a shallow
 * copy carrying them, or the Pattern itself when nothing changed. Never mutates
 * the Pattern it is given. Idempotent: a completed Pattern completes to the
 * same bytes, with `name` the same instance. A host-only agent (no primary
 * tool) has nothing LLM-facing and comes back as given.
 *
 * Throws what placeReserved throws: INPUT_RESERVED_KEY for a hand-written or
 * undeclared reserved field, and the matching `*_UNSUPPORTED_INPUTS` when a
 * field is due on inputs that are not a ZodObject.
 */
export function completeToolInputs(pattern: Pattern): Pattern {
  const tool = pattern.kind === 'meta' ? pattern.tool : pattern.primary?.tool
  if (!tool) return pattern
  let inputs = placeReserved(
    pattern.id,
    tool.inputs,
    'references',
    deriveReferencesSchema(pattern.assetNeeds),
  )
  inputs = placeReserved(
    pattern.id,
    inputs,
    'name',
    producesAssets(pattern) ? PRODUCT_NAME_FIELD : undefined,
  )
  if (inputs === tool.inputs) return pattern
  const completed = { ...tool, inputs }
  if (pattern.kind === 'meta') return { ...pattern, tool: completed }
  // `tool` came from `primary`, so `primary` is present on both other kinds.
  return { ...pattern, primary: { ...pattern.primary!, tool: completed } } as Pattern
}

/**
 * Place a derived field under a reserved key. Three cases for what is there now:
 *   absent            → append `fresh` (when there is one)
 *   a derived instance → replace it with `fresh` — the stored schema always
 *                        matches the Pattern's own declaration, whatever list a
 *                        factory derived from — keeping the key's position
 *   anything else     → INPUT_RESERVED_KEY (hand-written)
 * A derived instance whose declaration now derives nothing is refused as
 * 'undeclared' rather than kept: a field the schema shows but nothing reads is
 * the exact falsehood this rule exists to remove. (It could not be dropped
 * quietly either: zod refuses .omit() on a refined object.)
 * Replacing on a refined base is a key overwrite, which only safeExtend allows,
 * and safeExtend drops object-level meta, which is re-attached minus `id`.
 * DESIGN: reserved-input-keys
 */
function placeReserved(
  patternId: string,
  inputs: ZodSchema<unknown>,
  key: ReservedInputKey,
  fresh: z.ZodType | undefined,
): ZodSchema<unknown> {
  if (!(inputs instanceof z.ZodObject)) {
    // No shape to inspect. Nothing due, nothing to refuse. A field that IS due
    // fails fast instead of being skipped: dispatch would parse the schema
    // as-is (.passthrough() is gated on the method existing — unions don't
    // have it), and the matched member object's default strip mode would drop
    // the key from parsedInput — for `references` blinding the UNKNOWN_SLOT
    // resolution net while the frozen catalog copy promises "unknown slot keys
    // are rejected", for `name` losing the product name without a word.
    if (fresh === undefined) return inputs
    throw unsupportedInputs(patternId, key)
  }
  const shape = inputs.shape as Record<string, unknown>
  if (!Object.hasOwn(shape, key)) {
    return fresh === undefined ? inputs : withField(inputs, key, fresh)
  }
  const current = shape[key]
  if (!isDerived(current)) throw reservedKeyError(patternId, key, 'hand-written')
  if (fresh === undefined) throw reservedKeyError(patternId, key, 'undeclared')
  // The name singleton is already in place: nothing to replace, and returning
  // the inputs by reference is what makes completion idempotent by identity.
  if (current === fresh) return inputs
  return withField(inputs, key, fresh)
}

/**
 * `inputs` with `key` set to `field`: appended when absent, replaced in place
 * when present. safeExtend, not extend: .extend() throws ("Cannot overwrite
 * keys on object schemas containing refinements") when the base has
 * object-level checks and already carries the key — the replace path. safeExtend
 * does the same replacement, keeps the checks, and renders byte-identically to
 * extend where nothing is overwritten.
 */
function withField(
  inputs: z.ZodObject<z.ZodRawShape>,
  key: ReservedInputKey,
  field: z.ZodType,
): ZodSchema<unknown> {
  const extended = inputs.safeExtend({ [key]: field })
  // safeExtend drops the base's object-level metadata (registry-backed
  // .describe()/.meta()). Re-attach it minus `id` — the id names the BASE
  // schema; a duplicate id silently shadows the base in the registry's
  // _idmap and makes z.toJSONSchema throw ("Duplicate schema id") when both
  // schemas appear in one conversion tree (zod 4.4.3).
  // extended carries no own metadata (safeExtend produces a parentless
  // clone), so .meta()'s overwrite-not-merge semantics can't drop anything.
  const meta = { ...(inputs.meta() ?? {}) }
  delete meta.id
  return (Object.keys(meta).length > 0 ? extended.meta(meta) : extended) as ZodSchema<unknown>
}

/** Content at a reserved key that this Pattern's own declaration does not derive. */
function reservedKeyError(
  patternId: string,
  key: ReservedInputKey,
  reason: 'hand-written' | 'undeclared',
): Error {
  const message =
    reason === 'hand-written'
      ? `INPUT_RESERVED_KEY: ${patternId} declares a top-level "${key}" in its tool inputs. "${key}" is derived at registration (${key === 'references' ? 'from assetNeeds' : 'for a Pattern whose outputs carry assets[]'}); delete it.`
      : `INPUT_RESERVED_KEY: ${patternId} carries a derived "${key}" its own declaration does not produce (${key === 'references' ? 'it declares no assetNeeds' : 'its outputs carry no assets[]'}); build its inputs without it.`
  return Object.assign(new Error(message), {
    code: 'INPUT_RESERVED_KEY',
    details: { patternId, key, reason },
  })
}

/** A reserved field is due, but the tool inputs have no shape to place it in. */
function unsupportedInputs(patternId: string, key: ReservedInputKey): Error {
  if (key === 'references') {
    // Construction-time author error — fail fast, same as
    // DERIVE_REFERENCES_DUPLICATE_SLOT. Unchanged since before `name` existed.
    return new Error(
      `EXTEND_REFERENCES_UNSUPPORTED_INPUTS: ${patternId} — assetNeeds declared but tool inputs is not a ZodObject; define the input schema with z.object()`,
    )
  }
  return Object.assign(
    new Error(
      `EXTEND_NAME_UNSUPPORTED_INPUTS: ${patternId} — its outputs carry assets[] but its tool inputs is not a ZodObject; define the input schema with z.object()`,
    ),
    { code: 'EXTEND_NAME_UNSUPPORTED_INPUTS' },
  )
}
