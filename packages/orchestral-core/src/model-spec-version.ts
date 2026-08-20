// The adapter-contract generation marker for `ModelCapability`.
//
// `ModelCapability.call` is the one thing a host writes by hand, and it is the
// contract most likely to move (a changed `call` signature, a widened events
// channel, a different DispatchResult envelope). A runtime that meets an
// adapter built against a LATER generation must say so, not call it and fail
// somewhere deep inside the provider bridge. That is all this file is: the
// version vocabulary, the constant an adapter author references, and the guard
// the dispatch path runs before it invokes `call`.
//
// Prior art: the Vercel AI SDK's `specificationVersion` on provider models.

/**
 * Adapter-contract generations this build of the library can execute.
 *
 * Today there is exactly one. When the `call` contract changes
 * incompatibly the union widens to `'v1' | 'v2'` for as long as both are
 * executable, and narrows again when support for the older one is dropped.
 *
 * Because the union is a compile-time literal type, an adapter compiled
 * against THIS version of the package cannot declare a version this package
 * does not know — that is a type error. The runtime check exists for the case
 * the type system cannot see: an adapter compiled against a NEWER
 * `@orchestral/core` (its own dependency), shipped as a separate package, and
 * handed to an older runtime at wiring time.
 */
export type ModelSpecVersion = 'v1'

/**
 * The adapter contract this build implements — what a new adapter should
 * declare as `ModelCapability.specificationVersion`, referenced rather than
 * hard-coded so a bump surfaces at the import site:
 *
 * ```ts
 * import { MODEL_SPEC_VERSION, type ModelCapability } from '@orchestral/core'
 *
 * const model: ModelCapability = {
 *   specificationVersion: MODEL_SPEC_VERSION,
 *   // …record fields…
 *   async call(input, ctx) { … },
 * }
 * ```
 */
export const MODEL_SPEC_VERSION: ModelSpecVersion = 'v1'

/**
 * Every generation this build can execute. A superset of
 * {@link MODEL_SPEC_VERSION} while an older contract is still supported;
 * the dispatch guard accepts exactly these.
 */
export const SUPPORTED_MODEL_SPEC_VERSIONS: readonly ModelSpecVersion[] = ['v1']

/** One sentence, both in the message and on the structured diagnostic. */
const SPEC_VERSION_HINT =
  'Upgrade @orchestral/core + @orchestral/runtime to a build that implements this adapter contract, or wire a ModelCapability built against a supported version.'

/**
 * A resolved model declares a `specificationVersion` this build cannot
 * execute. Structured on purpose, shaped like the router's
 * `ModelExcludedError`: `code` is stable and `diagnostic` reaches the host as
 * `JobError.details.diagnostic` through the runtime's error normalisation, so
 * a subscriber reads the received / supported versions without parsing prose.
 */
export class ModelSpecVersionUnsupportedError extends Error {
  readonly code = 'MODEL_SPEC_VERSION_UNSUPPORTED'
  readonly diagnostic: {
    /** `provider:modelId` of the offending envelope. */
    model: string
    /** Exactly what the adapter declared, verbatim. */
    received: string
    supported: readonly ModelSpecVersion[]
    hint: string
  }

  constructor(model: string, received: string) {
    super(
      `MODEL_SPEC_VERSION_UNSUPPORTED: ${model} declares ModelCapability specificationVersion '${received}', which this build cannot execute; supported: ${SUPPORTED_MODEL_SPEC_VERSIONS.map(
        (v) => `'${v}'`,
      ).join(', ')} (an adapter that declares nothing is read as '${MODEL_SPEC_VERSION}'). ${SPEC_VERSION_HINT}`,
    )
    this.diagnostic = {
      model,
      received,
      supported: SUPPORTED_MODEL_SPEC_VERSIONS,
      hint: SPEC_VERSION_HINT,
    }
  }
}

/**
 * The gate the dispatch path runs immediately before `ModelCapability.call`.
 * Pure and synchronous: no declaration (`undefined`) is the pre-versioning
 * generation and reads as {@link MODEL_SPEC_VERSION}; anything else must be a
 * version this build supports.
 *
 * Hosts that drive their own dispatch loop instead of `InlineRuntime` should
 * call this at the same seam — right before invoking `call` on a resolved
 * envelope — so an incompatible adapter fails with the same stable code.
 *
 * @throws ModelSpecVersionUnsupportedError when the declared version is not in
 * {@link SUPPORTED_MODEL_SPEC_VERSIONS}.
 */
export function assertSupportedModelSpecVersion(model: {
  readonly specificationVersion?: ModelSpecVersion
  readonly provider: string
  readonly modelId: string
}): void {
  const declared: unknown = model.specificationVersion
  // Absent = the generation that predates this field. Every adapter written
  // before it existed keeps dispatching unchanged.
  if (declared === undefined) return
  if (
    typeof declared === 'string' &&
    (SUPPORTED_MODEL_SPEC_VERSIONS as readonly string[]).includes(declared)
  ) {
    return
  }
  throw new ModelSpecVersionUnsupportedError(
    `${model.provider}:${model.modelId}`,
    typeof declared === 'string' ? declared : String(declared),
  )
}
