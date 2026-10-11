// Canonical-JSON idempotency hash. Replaces a naive `JSON.stringify(input)`
// approach that silently collided on Map / Set / Date / key-ordering /
// undefined / BigInt / Buffer. The canonical serialiser walks the input,
// sorts object keys, rejects non-JSON-safe types loudly, and emits a
// stable string for hashing.

import { createHash } from 'node:crypto'

import type { PatternId, ResolvedAssetRef } from '@orchestral/core'

export interface DeriveIdempotencyKeyInput {
  patternId: PatternId
  input: unknown
  /** Resolution pass output — folded in so the same input over different
   *  resolved assets dedupes apart. */
  assets?: readonly ResolvedAssetRef[]
  sessionId?: string
  /** The step's path in its dispatch tree (`JobSpec.stepKey`), which
   *  `ctx.step` sets on every child. Absent — a host's direct submit — hashes
   *  as `null`. */
  stepKey?: string
}

/**
 * Derive a deterministic idempotency key. Same input always produces the
 * same key. Loudly rejects values that can't be canonically serialised so
 * silent dedup collisions are impossible.
 *
 * ### What is hashed, and what deliberately is not
 *
 * The field list below is a hand-picked allowlist, not a spread of the
 * JobSpec. Two dispatches dedupe iff they agree on **what work to do**:
 *
 *   • `patternId` — which Pattern runs
 *   • `input` — the Pattern's own arguments, the derived `references` and
 *     `name` included. A product's name is part of what the caller asked
 *     for: the same prompt under two names is two products, and a retry
 *     repeats the name, so it still dedupes
 *   • `assets` — the resolution pass output, so the same literal input over
 *     different resolved assets dedupes apart
 *   • `sessionId` — dedup never crosses a session boundary
 *   • `stepKey` — where the dispatch sits in its tree: the ids of the steps
 *     that launched its compose, then its own name or, unnamed, its position
 *     among that compose's unnamed calls to the same pattern. The same input
 *     at two places is two units of work, and the same step finds its row run
 *     after run whatever ran around it. `null` for a dispatch no step made
 *
 * Everything else on JobSpec is **routing metadata** and is excluded on
 * purpose. An alternative Runtime implementation must keep it excluded:
 *
 *   • `providerOptions` — host-supplied defaults; folding them in would split
 *     the dedup space every time a host setting changes
 *   • `assetContextId` — names the ledger the handles resolve against; the
 *     resolution result is already covered by `assets`
 *   • `resolveHints` — a retry with a different model-exclusion set is the
 *     same work, routed elsewhere (and failed rows never dedupe anyway)
 *   • `stepIdNamespace` — the prefix a child meta puts on its own steps' ids.
 *     The field is not hashed; the path it carries is, once, as `stepKey`
 *   • `resumeFromRunId`, `jobKind` — execution-mode markers, not work identity
 *   • `idempotencyKey` — the caller-supplied override; when present the caller
 *     bypasses this function entirely. One consequence of the allowlist above
 *     survives that bypass and is enforced at the dedup hit instead: because
 *     `patternId` is hashed HERE, no key this function returns can land on
 *     another pattern's row, and `_submitJobInternal` refuses one that does
 *     (`IDEMPOTENCY_KEY_CROSS_PATTERN`). Everything else the override gives
 *     up — whether the input changed, whether the session is the same — is the
 *     caller's to answer
 *
 * Adding a field here changes dedup behaviour for every existing job row: a
 * dispatch that would have deduped runs once more and writes a new row.
 * Removing one does too. A field with no value is written as `null` rather
 * than left out, so the payload has one shape for every caller.
 * DESIGN: idempotency-identity-allowlist
 */
export function deriveIdempotencyKey(args: DeriveIdempotencyKeyInput): string {
  const canonical = JSON.stringify({
    patternId: args.patternId,
    input: canonicalise(args.input),
    assets: args.assets !== undefined ? canonicalise(args.assets) : null,
    sessionId: args.sessionId ?? null,
    stepKey: args.stepKey ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Walk a value and return a JSON-safe normalized version with sorted object
 * keys. Throws IDEMPOTENCY_NOT_SERIALISABLE for types we refuse to serialise
 * (Map / Set / Date / Buffer / BigInt / Symbol / functions / undefined inside
 * arrays). Plain undefined OBJECT properties are dropped (matches JSON
 * behaviour); arrays preserve their indices but reject `undefined` entries
 * because JSON.stringify would silently substitute null.
 * DESIGN: canonicalise-refuses-non-json
 */
function canonicalise(value: unknown): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    if (t === 'number' && !Number.isFinite(value as number)) {
      throw new IdempotencyNotSerialisableError(
        `non-finite number (${value}) cannot be canonicalised`,
      )
    }
    return value
  }
  if (t === 'undefined') {
    throw new IdempotencyNotSerialisableError(
      'undefined value at top level / array slot is ambiguous',
    )
  }
  if (t === 'bigint') {
    throw new IdempotencyNotSerialisableError(
      'bigint cannot be canonicalised — convert to string explicitly',
    )
  }
  if (t === 'symbol' || t === 'function') {
    throw new IdempotencyNotSerialisableError(`${t} cannot be canonicalised`)
  }
  if (Array.isArray(value)) {
    return value.map((entry, i) => {
      if (entry === undefined) {
        throw new IdempotencyNotSerialisableError(
          `undefined at array index ${i} — substitute null or filter`,
        )
      }
      return canonicalise(entry)
    })
  }
  // Object — reject non-plain (Date, Map, Set, Buffer, …).
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new IdempotencyNotSerialisableError(
      `non-plain object (${(value as object).constructor?.name ?? 'unknown'}) — use a plain dict`,
    )
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    out[k] = canonicalise(v)
  }
  return out
}

export class IdempotencyNotSerialisableError extends Error {
  readonly code = 'IDEMPOTENCY_NOT_SERIALISABLE'
  constructor(reason: string) {
    super(`IDEMPOTENCY_NOT_SERIALISABLE: ${reason}`)
  }
}
