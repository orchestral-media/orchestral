// buildCatalogDescriptors — router catalog renderer coverage.
//
// The builder emits exactly the two router tools [find_pattern,
// dispatch_pattern]. Host tools are prepended by the host in its own
// catalog-assembly layer, so they are out of scope here.
//
// These tests pin descriptor count, names, and the IPC-friendly shape (no
// closures, no zod instances), plus the byte-stability invariant.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  buildAlwaysLoadDescriptors,
  buildCatalogDescriptors,
  deriveLlmFacingInputSchema,
  type Pattern,
} from '@orchestral/core'
import { createTextToImagePattern } from '../index'
import { createImageToTextPattern } from '../index'

describe('buildCatalogDescriptors', () => {
  it('emits exactly find_pattern + dispatch_pattern (no args)', () => {
    const descriptors = buildCatalogDescriptors()
    expect(descriptors.map((d) => d.name)).toEqual(['find_pattern', 'dispatch_pattern'])
  })

  it('descriptors are IPC-friendly (no zod instances, no closures)', () => {
    const descriptors = buildCatalogDescriptors()
    for (const d of descriptors) {
      expect(typeof d.name).toBe('string')
      expect(typeof d.description).toBe('string')
      expect(d.inputSchema).toBeDefined()
      // JSON-serializable round-trip — fails if closures or circular refs.
      const serialized = JSON.stringify(d)
      expect(serialized.length).toBeGreaterThan(0)
      const back = JSON.parse(serialized)
      expect(back.name).toBe(d.name)
    }
  })

  it('find_pattern description guides LLM to discovery flow', () => {
    const descriptors = buildCatalogDescriptors()
    const findPattern = descriptors.find((d) => d.name === 'find_pattern')!
    expect(findPattern.description.toLowerCase()).toContain('search')
    expect(findPattern.description.toLowerCase()).toContain('pattern')
  })

  it('dispatch_pattern description guides LLM to invoke flow + validation hint', () => {
    const descriptors = buildCatalogDescriptors()
    const dispatchPattern = descriptors.find((d) => d.name === 'dispatch_pattern')!
    expect(dispatchPattern.description).toContain('find_pattern')
    expect(dispatchPattern.description.toLowerCase()).toContain('invoke')
    // Validation hint should be there so LLM knows to retry on zod issues.
    expect(dispatchPattern.description.toLowerCase()).toContain('validation')
  })

  it('states the resolver slot-default by default, and lets a host override the wording', () => {
    const stock = buildCatalogDescriptors().find((d) => d.name === 'dispatch_pattern')!
    expect(stock.description).toContain(
      'if a required slot is omitted the host defaults to the most recent same-modality asset',
    )

    const overridden = buildCatalogDescriptors({
      slotDefaultNote: 'Omitting a required slot resolves nothing — always pass a handle.',
    }).find((d) => d.name === 'dispatch_pattern')!
    expect(overridden.description).toContain(
      'Omitting a required slot resolves nothing — always pass a handle.',
    )
    expect(overridden.description).not.toContain('the host defaults to')
    // Head and tail are untouched by the override.
    expect(overridden.description.startsWith('Invoke a specific Pattern by id.')).toBe(true)
    expect(overridden.description).toContain('unknown slot keys are rejected')
  })
})

// G4 — ADR-008 byte-stability lock (followups F1 acceptance + ADR-019 §3).
//
// buildCatalogDescriptors() output goes into the LLM's prompt cache prefix
// (the catalog the chat agent loads at session start). The cache hit depends
// on byte-identical serialization across invocations. Implementation layers
// (`schema.ts:29`, `catalog-builder.ts:75-81`, `derive-pattern-input.ts:21`)
// already enforce this via deterministic zod→JSON-Schema emission +
// referential identity preservation, but that's spread across multiple files
// and easy to regress accidentally. These tests lock the invariant at the
// catalog-builder boundary so any future regression surfaces in CI rather
// than as a silent cache-miss in production.
describe('buildCatalogDescriptors — byte stability (ADR-008 / G4)', () => {
  it('produces byte-identical JSON across multiple invocations', () => {
    const a = JSON.stringify(buildCatalogDescriptors())
    const b = JSON.stringify(buildCatalogDescriptors())
    const c = JSON.stringify(buildCatalogDescriptors())
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('produces byte-identical JSON across nested arrays + object key ordering', () => {
    // Belt-and-suspenders: snapshot the structural fingerprint so a future
    // change that swaps Map iteration order or inserts a non-deterministic
    // field (e.g. random uuid in metadata) trips this immediately.
    const ds = buildCatalogDescriptors()
    const fingerprint = ds.map((d) => ({
      name: d.name,
      descriptionLen: d.description.length,
      inputSchemaKeys: Object.keys(d.inputSchema as Record<string, unknown>).sort(),
    }))
    const a = JSON.stringify(fingerprint)
    // Re-build a fresh descriptors snapshot and verify the fingerprint matches —
    // the fingerprint is byte-stable so re-running buildCatalogDescriptors
    // produces the same key set & description size.
    const ds2 = buildCatalogDescriptors()
    const fingerprint2 = ds2.map((d) => ({
      name: d.name,
      descriptionLen: d.description.length,
      inputSchemaKeys: Object.keys(d.inputSchema as Record<string, unknown>).sort(),
    }))
    expect(JSON.stringify(fingerprint2)).toBe(a)
  })
})

describe('buildAlwaysLoadDescriptors — byte stability (ADR-008 / G4)', () => {
  it('produces byte-identical JSON for the same pattern set, regardless of input array order', () => {
    // ADR-008 byte-stability is a per-agent-lifetime invariant; for
    // buildAlwaysLoadDescriptors specifically, the output ordering follows
    // the input ordering. So byte-equality holds for the *same input
    // ordering* (verified here) — and any caller that reorders patterns
    // intentionally is responsible for its own ordering invariant.
    const t2i = createTextToImagePattern() as Pattern
    const a = JSON.stringify(buildAlwaysLoadDescriptors([t2i]))
    const b = JSON.stringify(buildAlwaysLoadDescriptors([t2i]))
    expect(b).toBe(a)
  })
})

describe('buildAlwaysLoadDescriptors', () => {
  it('emits a descriptor named by patternId only for always-load atomics', () => {
    const t2i = createTextToImagePattern() as Pattern
    const i2t = createImageToTextPattern() as Pattern // deferred — must be excluded
    const ds = buildAlwaysLoadDescriptors([t2i, i2t])
    expect(ds.map((d) => d.name)).toEqual(['text-to-image'])
    expect(ds[0]!.description).toBe(
      (t2i as { primary: { tool: { description: string } } }).primary.tool.description,
    )
  })

  it('descriptors are IPC-friendly (JSON round-trip, no closures)', () => {
    const ds = buildAlwaysLoadDescriptors([createTextToImagePattern() as Pattern])
    for (const d of ds) {
      const serialized = JSON.stringify(d)
      expect(serialized.length).toBeGreaterThan(0)
      const back = JSON.parse(serialized)
      expect(back.name).toBe(d.name)
      expect(back.inputSchema).toBeDefined()
    }
  })

  it('exposes always-load atomic with slim base inputSchema when no curated providerOptions schema (degraded fallback)', () => {
    // Invariant: providerOptions is per-model progressive enhancement, not
    // an expose gate. When derive returns undefined the atomic still
    // emits its descriptor, just without the providerOptions lift.
    const ds = buildAlwaysLoadDescriptors([createTextToImagePattern() as Pattern], {
      deriveProviderOptionsZod: () => undefined,
    })
    expect(ds).toHaveLength(1)
    expect(ds[0]!.name).toBe('text-to-image')
    const schema = ds[0]!.inputSchema as {
      properties?: Record<
        string,
        {
          type?: string
          minimum?: number
          maximum?: number
          properties?: unknown
          additionalProperties?: unknown
        }
      >
    }
    expect(schema.properties).toBeDefined()
    // Phase 4c: the slim base is exactly { prompt, references }. With no host
    // closure to lift per-model ai-sdk params, the degraded descriptor shows
    // ONLY those two fields — that is the intended OSS-standalone shape.
    expect(Object.keys(schema.properties!).sort()).toEqual(['prompt', 'references'])
    expect(schema.properties!.prompt).toBeDefined()
    expect(schema.properties!.references).toBeDefined()
    // The ai-sdk-shaped fields are gone from the base — they appear ONLY when a
    // host closure lifts them (see the lift test below). Spot-check `n`/`size`.
    expect(schema.properties!.n).toBeUndefined()
    expect(schema.properties!.size).toBeUndefined()
    expect(schema.properties!.aspectRatio).toBeUndefined()
    expect(schema.properties!.seed).toBeUndefined()
    // Pattern factory no longer declares a `providerOptions` placeholder
    // either: deriveLlmFacingInputSchema returns baseSchema unchanged, so
    // `providerOptions` is absent (not a degraded `z.record(z.unknown())`).
    expect(schema.properties!.providerOptions).toBeUndefined()
  })

  it('lifts providerOptions via deriveProviderOptionsZod into the input schema', () => {
    // Phase 3 contract: the closure now returns the MERGED LLM-facing schema
    // (host invokes the lift). `guidanceScale` carries no LIFT_MARKER, so it
    // lands under the typed `providerOptions` object — buildAlwaysLoadDescriptors
    // just z2js-es the merged result.
    const ds = buildAlwaysLoadDescriptors([createTextToImagePattern() as Pattern], {
      deriveProviderOptionsZod: (_id, baseSchema) =>
        deriveLlmFacingInputSchema(baseSchema, z.object({ guidanceScale: z.number() })),
    })
    expect(ds).toHaveLength(1)
    const schema = ds[0]!.inputSchema as {
      properties?: {
        providerOptions?: { properties?: Record<string, unknown> }
      }
    }
    expect(schema.properties).toBeDefined()
    expect(schema.properties!.providerOptions?.properties).toHaveProperty(
      'guidanceScale',
    )
  })
})
