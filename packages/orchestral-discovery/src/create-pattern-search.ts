// The first-party `PatternSearch` — this package's answer to the seam
// @orchestral/core declares and @orchestral/runtime consumes.
//
// Everything here is wiring: `handleFindPattern` already is the handler and
// `PatternSearchIndex` already is the corpus. What was missing was one
// function a host can hand to `new InlineRuntime({ patternSearch })` without
// writing the adapter itself — the reason the runtime used to import this
// package instead of asking for it.

import type { z } from 'zod'

import type {
  CapabilityRouter,
  PatternRegistry,
  PatternSearchRequest,
} from '@orchestral/core'

import { handleFindPattern, type FindPatternResult } from './find-pattern'
import { PatternSearchIndex } from './pattern-search-index'

/** Host-owned knobs the seam's request does not carry. */
export interface CreatePatternSearchOptions {
  /**
   * When supplied, atomic Patterns whose primary modelTags no model can
   * satisfy are dropped before the model ever sees them. Pass the same router
   * the runtime got: nothing else in this call knows how to route, and the
   * request deliberately carries only a `ResolveContext`.
   */
  router?: CapabilityRouter
  /** Max matches per call. Defaults to `DEFAULT_SEARCH_K` (5). */
  k?: number
  /**
   * Model-aware schema derivation, forwarded verbatim to
   * `HandleFindPatternOptions.deriveProviderOptionsZod` — the host performs
   * the lift/merge and this package only serialises what comes back.
   */
  deriveProviderOptionsZod?: (
    patternId: string,
    baseSchema: z.ZodObject<z.ZodRawShape>,
  ) => z.ZodObject<z.ZodRawShape> | undefined
}

/**
 * Build a `PatternSearch` over a registry.
 *
 * The index is built per call rather than once per factory. That is the
 * honest default for a registry the host may still be registering into — the
 * runtime it replaces built one per agent dispatch for the same reason — and
 * it costs a fraction of a millisecond for the 20-50 Pattern corpora this
 * library is sized for. A host with a large, frozen catalog that wants the
 * index kept can build a `PatternSearchIndex` itself and call
 * `handleFindPattern` from its own closure; this factory is the wiring, not
 * the only way in.
 *
 * Typed to its own result rather than to the bare `PatternSearch`: what the
 * runtime needs is assignability into the seam (which this satisfies), and a
 * host calling it directly should still see the shape it gets back.
 */
export function createPatternSearch(
  registry: PatternRegistry,
  options: CreatePatternSearchOptions = {},
): (req: PatternSearchRequest) => FindPatternResult {
  return (req) =>
    handleFindPattern(new PatternSearchIndex(registry), req.input, {
      audience: req.audience,
      ...(options.router ? { router: options.router } : {}),
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.deriveProviderOptionsZod
        ? { deriveProviderOptionsZod: options.deriveProviderOptionsZod }
        : {}),
      ...(req.resolveCtx ? { resolveCtx: req.resolveCtx } : {}),
      ...(req.includeOnly ? { includeOnly: req.includeOnly } : {}),
      ...(req.excludeIds ? { excludeIds: req.excludeIds } : {}),
      ...(req.directToolIds ? { directToolIds: req.directToolIds } : {}),
    })
}
