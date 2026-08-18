// Bounded output-field vocabulary for Pattern / host-tool outputs schemas.
//
// Companion to sanitize.ts: that module guesses binary from content shape at
// the boundary; this one makes the guess unnecessary at the source. When every
// string field in an outputs schema carries an explicit upper bound, an
// unbounded blob is unrepresentable — a Pattern cannot accidentally push
// megabytes of base64 into the model's context. Authors pick the bound that
// names their intent; auditOutputsSchema flags any bare z.string() that
// slipped through.

import { z, type ZodType } from 'zod'

import { toJsonSchema } from './schema'

/** Prose / label fields. Pick the smallest honest max. */
export function boundedText(max: number) {
  return z.string().max(max)
}

/**
 * Opaque pagination cursors / provider tokens. Generous but bounded.
 * Default 16_384 = 2^14, ~3× a saturated refkit cursor (~5KB), the largest
 * legit opaque token we've seen.
 */
export function opaqueToken(max = 16_384) {
  return z.string().max(max)
}

/** Asset ids / context handles. */
export function assetIdField() {
  return z.string().max(128)
}

/** Canonical / thumbnail URLs (any scheme). */
export function urlField(max = 2_048) {
  return z.string().max(max)
}

export interface OutputsSchemaAudit {
  /** Dotted paths of string fields that carry no `maxLength`. */
  unbounded: string[]
  /**
   * Dotted paths the walk could not inspect — an unresolved `$ref`, or an
   * object that permits arbitrary additional properties. A string of any
   * length can hide behind these, so `unbounded: []` is only a proof of
   * boundedness when this list is empty too.
   */
  notTraversed: string[]
}

/**
 * Audit an outputs schema for unbounded strings. Runs off the public
 * `toJsonSchema` projection rather than zod internals, so it stays stable
 * across zod minor versions.
 *
 * The walk covers object properties, array items, tuple `prefixItems`, record
 * values (`additionalProperties`), and `anyOf` / `oneOf` / `allOf` branches.
 * Anything it cannot follow is reported in `notTraversed` instead of being
 * silently counted as clean.
 */
export function auditOutputsSchema(schema: ZodType): OutputsSchemaAudit {
  const audit: OutputsSchemaAudit = { unbounded: [], notTraversed: [] }
  visit(toJsonSchema(schema) as Record<string, unknown>, '', audit)
  return audit
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function visit(
  node: Record<string, unknown>,
  path: string,
  audit: OutputsSchemaAudit,
): void {
  if ('$ref' in node) {
    audit.notTraversed.push(path)
    return
  }
  // An empty schema (z.unknown() / z.any() serialise to `{}`) accepts a string
  // of any length — same blind spot as an empty `additionalProperties` below,
  // so it lands in the same bucket instead of silently passing the audit.
  if (Object.keys(node).length === 0) {
    audit.notTraversed.push(path || '(root)')
    return
  }
  const bad = audit.unbounded
  // Finite value sets (z.enum / z.literal) serialize as string nodes without
  // maxLength, but they can't hold a blob and callers can't .max() them
  // (not ZodString) — skip, don't flag.
  if (
    node.type === 'string' &&
    typeof node.maxLength !== 'number' &&
    !('const' in node) &&
    !('enum' in node)
  ) {
    bad.push(path)
    return
  }
  if (node.type === 'object') {
    for (const [k, v] of Object.entries(
      (node.properties as Record<string, Record<string, unknown>>) ?? {},
    )) {
      visit(v, path ? `${path}.${k}` : k, audit)
    }
    // z.record → additionalProperties holds the value schema. A loose/
    // passthrough object serialises it as `true` or `{}` — an empty schema
    // accepts a string of any length, which is exactly the blind spot.
    const extra = node.additionalProperties
    if (extra === true || (isPlainObject(extra) && Object.keys(extra).length === 0)) {
      audit.notTraversed.push(`${path}{*}`)
    } else if (isPlainObject(extra)) {
      visit(extra, `${path}{*}`, audit)
    }
  }
  if (node.type === 'array') {
    if (node.items) visit(node.items as Record<string, unknown>, `${path}[]`, audit)
    // z.tuple → prefixItems, one schema per position.
    const prefix = node.prefixItems as Record<string, unknown>[] | undefined
    if (prefix) {
      prefix.forEach((v, i) => visit(v, `${path}[${i}]`, audit))
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const v of (node[key] as Record<string, unknown>[] | undefined) ?? []) {
      visit(v, path, audit)
    }
  }
}
