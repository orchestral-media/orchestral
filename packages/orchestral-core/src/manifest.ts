// The `"orchestral"` field of a pattern package's package.json — what a package
// says it contributes, in a form that can be read WITHOUT executing it:
//
//   npm view orchestral-pattern-foo orchestral
//
// That constraint drives the shape. Every entry is a string a registry lookup
// or a `module[name]` access can be built from; nothing here is a callback, a
// path to import, or a value only the running package could produce. Discovery
// is therefore a query — the npm keyword `orchestral-pattern`, the GitHub topic
// of the same name, the `orchestral-pattern-*` name convention — and there is
// no central registry to be admitted to.
//
// This is a convention plus a loader (`PatternRegistry.addFromManifest`), not a
// plugin framework: no lifecycle, no sandbox, no version negotiation, no
// activation events. A pattern package is an ordinary npm package whose
// factories a host could equally well call by hand; the manifest only removes
// the hand-written wiring and the drift that comes with it.

import { z } from 'zod'
import type { Pattern } from './pattern'

// `satisfies` rather than a bare literal: if a Pattern kind is ever renamed,
// this stops compiling instead of silently accepting a manifest nothing can
// build.
const PATTERN_KINDS = [
  'atomic',
  'meta',
  'agent',
] as const satisfies readonly Pattern['kind'][]

type ManifestPatternKind = (typeof PATTERN_KINDS)[number]

/**
 * One pattern the package contributes. `export` is the name of a FACTORY on
 * the package entry point (`module[export]()` returns the Pattern), not the
 * Pattern itself: patterns are built per-registry, and several first-party
 * factories take host operations as their argument.
 *
 * `id` and `kind` are declared rather than derived so a reader — or an audit
 * script over `npm view` output — knows what a package contributes without
 * running it. `addFromManifest` verifies both against the built Pattern, so a
 * stale manifest fails loudly instead of quietly registering something else.
 */
export const OrchestralManifestPatternSchema = z
  .object({
    /** Pattern id, e.g. `text-to-image` / `meta_storyboard` / `agent_x`. */
    id: z.string().min(1),
    kind: z.enum(PATTERN_KINDS),
    /** Export name of the factory on the package entry point. */
    export: z.string().min(1),
  })
  .refine((entry) => idCarriesKind(entry.id, entry.kind), {
    message:
      'id must carry its kind: "meta_" prefix for meta, "agent_" prefix for agent, a bare capability id for atomic',
  })

export type OrchestralManifestPattern = z.infer<
  typeof OrchestralManifestPatternSchema
>

/**
 * The `"orchestral"` field of a pattern package's package.json.
 *
 * Unknown keys are IGNORED rather than rejected: a package built against a
 * later manifest shape must still load on an older `@orchestral/core`. That
 * forward compatibility is why there is no version discriminator — the
 * package's own semver and its `@orchestral/core` peer range already carry
 * that information, and a second version number would only be a second thing
 * to keep in sync.
 */
export const OrchestralManifestSchema = z.object({
  patterns: z
    .array(OrchestralManifestPatternSchema)
    .min(1, 'a manifest must declare at least one pattern')
    .refine(
      (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
      { message: 'duplicate pattern id in manifest' },
    ),
  /**
   * Names of host operations the package's factories expect on the object
   * passed to them — the ffmpeg-shaped work (`concatVideos`, `addSubtitles`, …)
   * a meta cannot do itself. Declarative for a reader deciding whether the
   * package is usable at all, and enforced by `addFromManifest`, which refuses
   * to register anything when one is missing rather than failing halfway
   * through a pipeline hours later.
   */
  requiredOps: z.array(z.string().min(1)).optional(),
})

export type OrchestralManifest = z.infer<typeof OrchestralManifestSchema>

export type ManifestErrorCode =
  /** The `"orchestral"` field does not match {@link OrchestralManifestSchema}. */
  | 'MANIFEST_INVALID'
  /** A `requiredOps` entry is absent from the ops object the caller passed. */
  | 'MANIFEST_MISSING_OPS'
  /** No export by that name on the module — usually a renamed factory. */
  | 'MANIFEST_EXPORT_MISSING'
  /** The export exists but is not callable. */
  | 'MANIFEST_EXPORT_NOT_A_FACTORY'
  /** The factory ran but produced a different id / kind than declared. */
  | 'MANIFEST_PATTERN_MISMATCH'

/**
 * Thrown by `PatternRegistry.addFromManifest`. `code` is switchable; the
 * message repeats it as a prefix, matching every other error this package
 * throws (`PATTERN_ALREADY_REGISTERED: …`), so a log line stays readable when
 * only the message survives.
 */
export class ManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}

/**
 * The id prefix is normative, not cosmetic — the sub-agent recursion guard and
 * `inferNamespace` both route on it (see foundational.ts). Checking it here
 * makes the manifest self-describing to a static reader: an `agent_` id in the
 * list IS an agent.
 */
function idCarriesKind(id: string, kind: ManifestPatternKind): boolean {
  if (kind === 'meta') return id.startsWith('meta_')
  if (kind === 'agent') return id.startsWith('agent_')
  return !id.startsWith('meta_') && !id.startsWith('agent_')
}
