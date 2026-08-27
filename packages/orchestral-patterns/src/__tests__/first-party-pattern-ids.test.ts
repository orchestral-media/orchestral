import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  FIRST_PARTY_PATTERN_IDS,
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  PLAN_PATTERN_ID,
  TEXT_TO_IMAGE_PATTERN_ID,
} from '../index'

// Drift gate. FIRST_PARTY_PATTERN_IDS exists so a consumer stops re-typing the
// catalog — @orchestral/agent's orchestrator did exactly that and drifted once
// (a bare `image-to-image-via-caption` that resolves to nothing). A derived
// list is only worth reading if it cannot itself fall behind the `orchestral`
// manifest, which is the list a registry actually loads, so this compares the
// two directly rather than pinning a third copy of the literals.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { orchestral: { patterns: ReadonlyArray<{ id: string; kind: string }> } }

const manifestIds = (kind: string): string[] =>
  pkg.orchestral.patterns.filter((p) => p.kind === kind).map((p) => p.id)

describe('FIRST_PARTY_PATTERN_IDS', () => {
  it('lists exactly the manifest ids, grouped by the kind the manifest declares', () => {
    // Order matters as much as membership: consumers splice the two groups to
    // get a catalog order, and a reviewable diff needs a stable one.
    expect([...FIRST_PARTY_PATTERN_IDS.atomic]).toEqual(manifestIds('atomic'))
    expect([...FIRST_PARTY_PATTERN_IDS.meta]).toEqual(manifestIds('meta'))
  })

  it('groups via-caption as meta — the id prefix, not the source directory, is the kind', () => {
    // Authored under atomic/, ships as kind:'meta' (the meta_ prefix routes it
    // to the meta-pipelines namespace). Grouping it by directory would hand
    // every consumer the wrong catalog.
    expect(FIRST_PARTY_PATTERN_IDS.meta).toContain(
      IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
    )
    expect(FIRST_PARTY_PATTERN_IDS.atomic).not.toContain(
      IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
    )
  })

  it('carries the shipped id constants themselves, not fresh literals', () => {
    expect(FIRST_PARTY_PATTERN_IDS.atomic).toContain(TEXT_TO_IMAGE_PATTERN_ID)
    expect(FIRST_PARTY_PATTERN_IDS.meta).toContain(PLAN_PATTERN_ID)
  })

  it('is frozen at both levels — a consumer cannot mutate the shared catalog', () => {
    expect(Object.isFrozen(FIRST_PARTY_PATTERN_IDS)).toBe(true)
    expect(Object.isFrozen(FIRST_PARTY_PATTERN_IDS.atomic)).toBe(true)
    expect(Object.isFrozen(FIRST_PARTY_PATTERN_IDS.meta)).toBe(true)
  })
})
