// slash-dispatch — user-driven by-id dispatch resolution.
//
// User slash (`/name`) = a user-level `select:`: the user supplies an exact
// pattern id (full id OR unqualified short name); the registry resolves it and
// the host dispatches it directly, bypassing find_pattern / LLM selection.
//
// This module owns the pure resolution + the `exposure.slash` gate so the
// host's own entry point stays thin (resolve here, then reuse the existing
// dispatch pipeline with `audience: 'slash'`). Returning (not throwing) keeps
// the failure modes structured so the caller can surface a precise message.
//
// Scope: resolution only. Anything a user-facing command surface needs on top
// — a completion menu, a schema-driven form, an asset picker — is the host's
// own concern.

import { resolveExposure } from './pattern'
import type { PatternRegistry } from './registry'

/**
 * Structured failure modes for slash resolution.
 * @alpha
 */
export type SlashDispatchError =
  | {
      code: 'SLASH_PATTERN_NOT_FOUND'
      patternId: string
      message: string
    }
  | {
      code: 'SLASH_NOT_EXPOSED'
      patternId: string
      message: string
    }

/**
 * Resolution result: either the canonical full id, or a structured error.
 * @alpha
 */
export type SlashDispatchResolution =
  | { ok: true; fullId: string }
  | { ok: false; error: SlashDispatchError }

/**
 * Resolve a user-supplied slash target to a canonical full pattern id, gated by
 * `exposure.slash`. Pure — the host caller takes `fullId` and forwards it into
 * the existing dispatch pipeline (`executeDispatch` with `audience: 'slash'`).
 *
 * Resolution order:
 *   1. `registry.get(patternId)` — treats the input as a full id.
 *   2. `registry.resolveShortName(patternId)` → `registry.get(...)` — treats it
 *      as an unqualified short name (e.g. `text-to-image`).
 *
 * Gate (fail-closed): only `resolveExposure(pattern.exposure).slash === true`
 * passes. First-party Patterns do not opt into slash; a host opts its own
 * Patterns in.
 * @alpha
 */
export function resolveSlashDispatch(
  registry: PatternRegistry,
  patternId: string,
): SlashDispatchResolution {
  const pattern =
    registry.get(patternId) ??
    (() => {
      const fullId = registry.resolveShortName(patternId)
      return fullId ? registry.get(fullId) : undefined
    })()

  if (!pattern) {
    return {
      ok: false,
      error: {
        code: 'SLASH_PATTERN_NOT_FOUND',
        patternId,
        message: `No pattern matches "${patternId}" (tried full id and short name).`,
      },
    }
  }

  if (!resolveExposure(pattern.exposure).slash) {
    return {
      ok: false,
      error: {
        code: 'SLASH_NOT_EXPOSED',
        patternId,
        message: `Pattern "${pattern.id}" is not exposed to slash commands (exposure.slash !== true).`,
      },
    }
  }

  return { ok: true, fullId: pattern.id }
}
