// Regression — best-of-n's judge must actually receive the caller's reference
// images.
//
// meta_image-best-of-n feeds the judge two channels that both land on the
// image-to-text `source` slot: the N candidates ride the internal `ref.assets`
// channel, and the caller's `referenceHandles` ride the LLM-facing handle
// channel (input.references.source), resolved by the host `resolveStepReferences`
// seam. The judge prompt unconditionally labels "Reference Image 0..M-1" then
// "Generated Image 0..N-1", so the payload MUST carry the references ahead of
// the candidates in that same slot.
//
// This drives the REAL createImageBestOfNMeta().compose() through the REAL
// buildMetaExecutionContext merge (not a mock ctx.step), with a faithful
// resolver that resolves `references.source` into slot 'source' exactly as the
// host bridge does for image-to-text's `source` assetNeeds. Before the merge fix
// the same-slot references were dropped, so the judge saw only candidates while
// the prompt still claimed N references — labels and images silently misaligned.
import { describe, expect, it } from 'vitest'

import type {
  AssetEvent,
  AssetIndex,
  AssetNeed,
  AssetReferences,
  Job,
  JobSpec,
  PatternId,
  ResolvedAssetRef,
} from '@orchestral/core'
import { buildAssetIndex, resolveAssetReferences } from '@orchestral/core'
import { createImageBestOfNMeta } from '@orchestral/patterns'
import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
} from '../meta-execution-context'

// Faithful stand-in for the host seam: image-to-text declares a single `source`
// assetNeeds slot, so a forwarded `references.source` handle resolves to a real
// assetId keyed to that slot. text-to-image candidates carry no references →
// resolver returns nothing for them.
function resolveSourceHandles(
  _patternId: PatternId,
  input: unknown,
): readonly ResolvedAssetRef[] {
  const source = (input as { references?: { source?: unknown } })?.references
    ?.source
  if (!Array.isArray(source)) return []
  return source.map((handle) => ({
    slot: 'source',
    assetId: `resolved-${String(handle)}`,
    modality: 'image' as const,
  }))
}

// image-to-text's REAL declared slot — a single `source` need, array/required
// (the judge stacks references + candidates). Used to drive the production
// resolveAssetReferences instead of a hand-written replica.
const IMAGE_TO_TEXT_SOURCE_NEEDS = [
  { slot: 'source', modality: 'image', cardinality: 'array', required: true },
] as const satisfies readonly AssetNeed[]

// Wire the ACTUAL core resolver (resolveAssetReferences) into the meta merge, so
// the slot-internal ordering invariant (output order == input handle order) is
// exercised end-to-end rather than assumed via a stand-in. Only image-to-text
// (the judge) declares assetNeeds here; candidates carry no references → [].
function makeRealResolver(index: AssetIndex): MetaCtxDeps['resolveStepReferences'] {
  return (patternId, input) => {
    if (patternId !== 'image-to-text') return []
    const res = resolveAssetReferences(
      input as { references?: AssetReferences },
      IMAGE_TO_TEXT_SOURCE_NEEDS,
      index,
    )
    // Fail-closed exactly like the host bridge seam.
    if (!res.ok) throw new Error(`ASSET_RESOLUTION_FAILED: ${res.error.code}`)
    return res.assets
  }
}

function doneJob(spec: JobSpec, output: unknown): Job {
  return {
    id: 'child',
    patternId: spec.patternId,
    idempotencyKey: 'k',
    status: 'done',
    input: spec.input,
    output,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

/**
 * Run the real meta through a real ExecutionContext, capturing every child
 * JobSpec. First `image-to-text` dispatch is the judge; every other dispatch is
 * a candidate image-gen that mints a deterministic assetId.
 */
async function runBestOfN(
  input: {
    n: number
    referenceHandles?: readonly string[]
    refDescriptions?: readonly string[]
    judgeJson: string
  },
  resolve: MetaCtxDeps['resolveStepReferences'] = resolveSourceHandles,
) {
  const childSpecs: JobSpec[] = []
  let candSeq = 0
  const deps: MetaCtxDeps = {
    submitChild: async (spec) => {
      childSpecs.push(spec as JobSpec)
      const output =
        spec.patternId === 'image-to-text'
          ? {
              modality: 'text',
              text: input.judgeJson,
              cost: 2,
              latencyMs: 50,
              model: 'test:vlm',
              provider: 'test',
            }
          : {
              modality: 'image',
              assets: [{ assetId: `cand-${candSeq++}` }],
              cost: 1,
              latencyMs: 100,
              model: 'test:t2i',
              provider: 'test',
            }
      return doneJob(spec as JobSpec, output) as never
    },
    resolveStepReferences: resolve,
    // Mirror production wiring: the runtime injects the child's declared
    // assetNeeds so the dual-source guard can tell single from array slots.
    // image-to-text's `source` is array → the judge's references+candidates
    // legitimately coexist (the guard must stay silent on this path).
    getAssetNeeds: (patternId) =>
      patternId === 'image-to-text' ? IMAGE_TO_TEXT_SOURCE_NEEDS : [],
  }
  const ctx = buildMetaExecutionContext(
    deps,
    'meta_image-best-of-n' as PatternId,
    'job_test',
    { patternId: 'meta_image-best-of-n' as PatternId, input: {} },
    new AbortController().signal,
    new Set<PatternId>(['meta_image-best-of-n' as PatternId]),
    makeFreshState(),
  )

  const out = await createImageBestOfNMeta().compose(
    {
      input: {
        innerPatternId: 'text-to-image',
        innerInput: { prompt: 'a knight' },
        n: input.n,
        targetDescription: 'a knight matching the reference',
        ...(input.referenceHandles
          ? { referenceHandles: [...input.referenceHandles] }
          : {}),
        ...(input.refDescriptions
          ? { refDescriptions: [...input.refDescriptions] }
          : {}),
      },
    },
    ctx,
  )
  const judge = childSpecs.find((s) => s.patternId === 'image-to-text')!
  return { out, judge, childSpecs }
}

describe('meta_image-best-of-n — reference images reach the judge (real merge)', () => {
  it('merges resolved reference handles into the judge source slot AHEAD of the candidates', async () => {
    const { judge, out } = await runBestOfN({
      n: 2,
      referenceHandles: ['ref-a', 'ref-b'],
      refDescriptions: ['protagonist front view', 'protagonist side view'],
      judgeJson: JSON.stringify({
        best_image_index: 1,
        reason: 'matches the reference',
      }),
    })

    // The whole point: the judge dispatch carries BOTH channels on the single
    // 'source' slot — references first (labelled "Reference Image i"), then the
    // candidates (labelled "Generated Image i"). Before the fix the same-slot
    // references were filtered out and only the candidates survived.
    expect(judge.assets).toEqual([
      { slot: 'source', assetId: 'resolved-ref-a', modality: 'image' },
      { slot: 'source', assetId: 'resolved-ref-b', modality: 'image' },
      { slot: 'source', assetId: 'cand-0', modality: 'image' },
      { slot: 'source', assetId: 'cand-1', modality: 'image' },
    ])

    // The prompt labels line up 1:1 with that payload order (2 refs, then 2
    // candidates) — no label/image drift for the VLM to trip on.
    const prompt = (judge.input as { prompt: string }).prompt
    const refA = prompt.indexOf('Reference Image 0: protagonist front view')
    const refB = prompt.indexOf('Reference Image 1: protagonist side view')
    const genA = prompt.indexOf('Generated Image 0')
    const genB = prompt.indexOf('Generated Image 1')
    expect(refA).toBeGreaterThanOrEqual(0)
    expect(refB).toBeGreaterThan(refA)
    expect(genA).toBeGreaterThan(refB)
    expect(genB).toBeGreaterThan(genA)

    // best_image_index stays candidate-relative → the 2nd candidate wins.
    expect(out.winningAssetId).toBe('cand-1')
  })

  it('carries only the candidates when no referenceHandles are supplied (zero regression)', async () => {
    const { judge } = await runBestOfN({
      n: 3,
      judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
    })

    expect(judge.assets).toEqual([
      { slot: 'source', assetId: 'cand-0', modality: 'image' },
      { slot: 'source', assetId: 'cand-1', modality: 'image' },
      { slot: 'source', assetId: 'cand-2', modality: 'image' },
    ])
    // No handle channel at all — no references block emitted.
    expect(
      (judge.input as { references?: unknown }).references,
    ).toBeUndefined()
  })

  it('preserves input handle order through the REAL resolveAssetReferences (order invariant)', async () => {
    // Drive the meta merge with the production core resolver, not a replica.
    // The index is built so its enumeration order (ref-a, ref-b) is the OPPOSITE
    // of the caller's handle order (ref-b, ref-a): if resolveAssetReferences ever
    // sorted by index/orderHint instead of iterating the given handles, the
    // judge payload and its "Reference Image i" labels would diverge.
    const events: AssetEvent[] = [
      { kind: 'asset', annotation: { assetId: 'resolved-ref-a', modality: 'image', handle: 'ref-a' }, orderHint: 0 },
      { kind: 'asset', annotation: { assetId: 'resolved-ref-b', modality: 'image', handle: 'ref-b' }, orderHint: 1 },
    ]
    const index = buildAssetIndex(events)
    expect(index.all().map((e) => e.handle)).toEqual(['ref-a', 'ref-b']) // index order

    const { judge, out } = await runBestOfN(
      {
        n: 2,
        referenceHandles: ['ref-b', 'ref-a'], // caller order = reverse of index
        refDescriptions: ['B caption', 'A caption'],
        judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
      },
      makeRealResolver(index),
    )

    // Payload follows the CALLER's handle order (ref-b then ref-a), ahead of the
    // candidates. The real resolver also stamps the source `handle` onto each
    // resolved ref — present here, absent on the internal candidate channel —
    // which is the tell that the production function actually ran.
    expect(judge.assets).toEqual([
      { slot: 'source', assetId: 'resolved-ref-b', modality: 'image', handle: 'ref-b' },
      { slot: 'source', assetId: 'resolved-ref-a', modality: 'image', handle: 'ref-a' },
      { slot: 'source', assetId: 'cand-0', modality: 'image' },
      { slot: 'source', assetId: 'cand-1', modality: 'image' },
    ])

    // Judge labels line up with that exact order: "Reference Image 0" is B's
    // caption, "Reference Image 1" is A's — handle order == payload order ==
    // label order, the whole point of the invariant.
    const prompt = (judge.input as { prompt: string }).prompt
    const ref0 = prompt.indexOf('Reference Image 0: B caption')
    const ref1 = prompt.indexOf('Reference Image 1: A caption')
    const gen0 = prompt.indexOf('Generated Image 0')
    expect(ref0).toBeGreaterThanOrEqual(0)
    expect(ref1).toBeGreaterThan(ref0)
    expect(gen0).toBeGreaterThan(ref1)

    expect(out.winningAssetId).toBe('cand-0')
  })
})
