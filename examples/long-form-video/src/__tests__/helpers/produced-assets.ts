// Shared assertions for the produced-assets envelope every media-producing
// meta returns: one flat top-level `assets[]`, every element carrying a role
// `label`, and no other field anywhere in the output holding a raw asset id.
//
// Why a walk and not a schema check: the model-facing projection
// (`projectToolOutputForModel` in @orchestral/core) rebuilds `assets[]` from
// the handle whitelist and passes every OTHER field through untouched, so a
// `videoAssetId` / `imageAssetIds` field anywhere — top level or nested —
// would reach the model verbatim. zod's default object mode strips unknown
// keys on parse, so a passing `.parse()` proves nothing about their absence.
//
// Not a test file (no `.test.ts` suffix) — vitest's include pattern skips it.
import { expect } from 'vitest'
import type { ZodType } from 'zod'
import { auditOutputsSchema } from '@orchestral/core'

/** The field-name shape the eight metas used to leak ids through. Deliberately
 *  case-sensitive: the `assetId` INSIDE an assets[] element does not match. */
const RAW_ASSET_ID_KEY = /AssetIds?$/

/** Dotted paths of every key in `value` (recursively) that names a raw asset-id field. */
export function rawAssetIdKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => rawAssetIdKeys(v, `${path}[${i}]`))
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k
    return [...(RAW_ASSET_ID_KEY.test(k) ? [here] : []), ...rawAssetIdKeys(v, here)]
  })
}

/** The assets[] element carrying `label`, or undefined. */
export function byLabel<A extends { label: string }>(
  out: { assets: ReadonlyArray<A> },
  label: string,
): A | undefined {
  return out.assets.find((a) => a.label === label)
}

/**
 * Assert the envelope on a meta output: no raw-id field anywhere, every
 * assets[] element labelled, the output valid against its own schema, and
 * that schema keeping the envelope bounded (no bare z.string() under assets).
 */
export function expectProducedAssetsEnvelope(schema: ZodType, out: unknown): void {
  expect(rawAssetIdKeys(out)).toEqual([])

  const assets = (out as { assets?: unknown }).assets
  expect(Array.isArray(assets)).toBe(true)
  for (const a of assets as unknown[]) {
    const el = a as { assetId?: unknown; modality?: unknown; label?: unknown }
    expect(typeof el.assetId).toBe('string')
    expect(typeof el.modality).toBe('string')
    expect(typeof el.label).toBe('string')
    expect((el.label as string).length).toBeGreaterThan(0)
  }

  expect(() => schema.parse(out)).not.toThrow()

  const audit = auditOutputsSchema(schema)
  expect(audit.unbounded.filter((p) => p.startsWith('assets'))).toEqual([])
  expect(audit.notTraversed.filter((p) => p.startsWith('assets'))).toEqual([])
}
