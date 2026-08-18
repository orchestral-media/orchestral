import type { AssetNeed } from './asset-index.types'
import type { NamespaceId } from './catalog'
import { extendInputsWithReferences } from './extend-inputs-with-references'
import type { PatternId, ZodSchema } from './foundational'
import type {
  AtomicPattern,
  PatternExposure,
  PatternExposureMode,
  PrimaryPath,
} from './pattern'
import type { Alternative } from './alternative'

export interface AtomicPatternInit<I = unknown, O = unknown> {
  id: PatternId
  /**
   * Catalog namespace. Optional for back-compat with older third-party
   * Patterns; first-party Patterns set it explicitly so find_pattern can
   * partition by namespace (kind=atomic + modality filter) and the registry
   * skips the `inferNamespace` fallback. See catalog.ts.
   */
  namespace?: NamespaceId
  description: string
  /** Required — every atomic Pattern has a primary path. */
  primary: PrimaryPath<I>
  outputs: ZodSchema<O>
  /**
   * Authoring-only sugar: `registry.add()` strips this off the Pattern and
   * expands each entry into an `attachAlternative` call. The registered
   * `Pattern` does not carry it — the registry's attachment table is the
   * runtime source of truth (read via `registry.getEntry()`).
   */
  alternatives?: readonly Alternative<I, O>[]
  /** See PatternBase.searchHint. */
  searchHint?: string
  /** Author-declared asset slots. See PatternBase.assetNeeds. */
  assetNeeds?: readonly AssetNeed[]
  /** See PatternBase.exposureMode. 'always-load' surfaces this atomic as a first-class tool. */
  exposureMode?: PatternExposureMode
  /** See PatternBase.exposure. Per-surface (or shorthand) catalog visibility. */
  exposure?: PatternExposure
}

/**
 * Build an atomic Pattern from its authoring init. Capability sub-modes are
 * expressed via `input.references` asset slots + a provider-self-reported
 * typed `providerOptions` schema; the returned value is a plain record
 * holding the primary path (with the derived `references` field injected
 * into its input schema).
 *
 * The return type keeps `alternatives` visible as registration sugar —
 * hand the result to `registry.add()`, which strips the field and attaches
 * each entry.
 */
export function defineAtomicPattern<I = unknown, O = unknown>(
  init: AtomicPatternInit<I, O>,
): AtomicPattern<I, O> & {
  readonly alternatives?: readonly Alternative<I, O>[]
} {
  if (!init.primary) {
    throw new Error(
      `ATOMIC_PATTERN_NO_PRIMARY: ${init.id} — primary path is required`,
    )
  }
  // SSOT injection of the derived `references` field — semantics live on
  // extendInputsWithReferences's JSDoc.
  const extendedInputs = extendInputsWithReferences(
    init.id,
    init.primary.tool.inputs,
    init.assetNeeds,
  )
  const primary =
    extendedInputs === init.primary.tool.inputs
      ? init.primary
      : {
          ...init.primary,
          tool: { ...init.primary.tool, inputs: extendedInputs },
        }
  return {
    kind: 'atomic' as const,
    id: init.id,
    ...(init.namespace !== undefined ? { namespace: init.namespace } : {}),
    description: init.description,
    primary,
    outputs: init.outputs,
    ...(init.alternatives !== undefined
      ? { alternatives: init.alternatives }
      : {}),
    ...(init.searchHint !== undefined ? { searchHint: init.searchHint } : {}),
    ...(init.assetNeeds !== undefined ? { assetNeeds: init.assetNeeds } : {}),
    ...(init.exposureMode !== undefined
      ? { exposureMode: init.exposureMode }
      : {}),
    ...(init.exposure !== undefined ? { exposure: init.exposure } : {}),
  }
}
