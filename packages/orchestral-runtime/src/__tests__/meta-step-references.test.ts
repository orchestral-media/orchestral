// Meta sub-step `input.references` handle resolution.
//
// A meta forwarding a caller handle to a sub-step (best-of-n's inner i2i
// `references.source`, via-caption's source) used to leave that handle
// unresolved — only the internal `ref.assets` channel reached the child, so the
// adapter saw zero source images. buildMetaExecutionContext now calls the host
// `resolveStepReferences` seam and merges its output into the child spec.assets.
//
// Drives buildMetaExecutionContext directly with a fake submitChild that
// captures every child JobSpec.
import { describe, expect, it } from 'vitest'

import type {
  AssetNeed,
  Job,
  JobSpec,
  PatternId,
  ResolvedAssetRef,
} from '@orchestral/core'
import {
  buildMetaExecutionContext,
  makeFreshState,
  type MetaCtxDeps,
} from '../meta-execution-context'

function doneJob(spec: JobSpec): Job {
  return {
    id: 'child',
    patternId: spec.patternId,
    idempotencyKey: 'k',
    status: 'done',
    input: spec.input,
    output: { ok: true },
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function buildCtx(opts: {
  resolve?: MetaCtxDeps['resolveStepReferences']
  getAssetNeeds?: MetaCtxDeps['getAssetNeeds']
  sessionId?: string
  assetContextId?: string
}) {
  const childSpecs: JobSpec[] = []
  const deps: MetaCtxDeps = {
    submitChild: async (spec) => {
      childSpecs.push(spec as JobSpec)
      return doneJob(spec as JobSpec) as never
    },
    ...(opts.resolve ? { resolveStepReferences: opts.resolve } : {}),
    ...(opts.getAssetNeeds ? { getAssetNeeds: opts.getAssetNeeds } : {}),
  }
  const ctx = buildMetaExecutionContext(
    deps,
    'meta_test' as PatternId,
    'job_test',
    {
      patternId: 'meta_test' as PatternId,
      input: {},
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.assetContextId ? { assetContextId: opts.assetContextId } : {}),
    },
    new AbortController().signal,
    new Set<PatternId>(['meta_test' as PatternId]),
    makeFreshState(),
  )
  return { ctx, childSpecs }
}

const RESOLVED_SRC: ResolvedAssetRef = {
  slot: 'source',
  assetId: 'real-asset-1',
  modality: 'image',
}

// image-to-image's `source` is single (one edit target); image-to-text's is
// array (the judge stacks references + candidates). The dual-source guard keys
// off the child pattern's declared cardinality, injected via getAssetNeeds.
const SINGLE_SOURCE_NEEDS = [
  { slot: 'source', modality: 'image', cardinality: 'single', required: true },
] as const satisfies readonly AssetNeed[]

const ARRAY_SOURCE_NEEDS = [
  { slot: 'source', modality: 'image', cardinality: 'array', required: true },
] as const satisfies readonly AssetNeed[]

const TWO_SINGLE_SLOT_NEEDS = [
  { slot: 'source', modality: 'image', cardinality: 'single', required: true },
  { slot: 'mask', modality: 'image', cardinality: 'single', required: true },
] as const satisfies readonly AssetNeed[]

describe('meta sub-step references resolution', () => {
  it('resolves a sub-step input.references handle into the child spec.assets', async () => {
    const seen: Array<{ patternId: string; input: unknown }> = []
    const { ctx, childSpecs } = buildCtx({
      resolve: (patternId, input) => {
        seen.push({ patternId, input })
        return [RESOLVED_SRC]
      },
    })

    await ctx.step({
      patternId: 'image-to-image' as PatternId,
      input: { prompt: 'edit', references: { source: 'image_1' } },
    })

    // The resolver was consulted with the child pattern id + its input.
    expect(seen).toEqual([
      { patternId: 'image-to-image', input: { prompt: 'edit', references: { source: 'image_1' } } },
    ])
    // The resolved assetId reached the child JobSpec.assets (→ DispatchContext.assets).
    expect(childSpecs[0]?.assets).toEqual([RESOLVED_SRC])
  })

  it('merges the internal ref.assets channel with handle-resolved refs (different slots)', async () => {
    const internal: ResolvedAssetRef = { slot: 'mask', assetId: 'mask-asset', modality: 'image' }
    const { ctx, childSpecs } = buildCtx({
      resolve: () => [RESOLVED_SRC],
    })

    await ctx.step({
      patternId: 'image-to-image' as PatternId,
      input: { references: { source: 'image_1' } },
      assets: [internal],
    })

    // Both channels present; resolved source comes first, internal mask appended.
    expect(childSpecs[0]?.assets).toEqual([RESOLVED_SRC, internal])
  })

  it('merges both channels on a same-slot clash when cardinality is unknown (no getAssetNeeds)', async () => {
    const internalSource: ResolvedAssetRef = { slot: 'source', assetId: 'internal-src', modality: 'image' }
    const { ctx, childSpecs } = buildCtx({
      resolve: () => [RESOLVED_SRC], // also slot 'source'
      // No getAssetNeeds → the dual-source guard can't read cardinality, so it
      // stays inert and the channels COEXIST. (A known-single slot is caught by
      // the DUAL_SOURCE_SINGLE_SLOT test below; a known-array slot legitimately
      // coexists — that's the best-of-n judge case.)
    })

    await ctx.step({
      patternId: 'image-to-image' as PatternId,
      input: { references: { source: 'image_1' } },
      assets: [internalSource],
    })

    // Resolved handle leads, internal asset appended — the array-style merge.
    expect(childSpecs[0]?.assets).toEqual([RESOLVED_SRC, internalSource])
  })

  it('throws DUAL_SOURCE_SINGLE_SLOT when a single-cardinality slot is fed by both channels', async () => {
    const internalSource: ResolvedAssetRef = {
      slot: 'source',
      assetId: 'internal-src',
      modality: 'image',
    }
    const { ctx } = buildCtx({
      resolve: () => [RESOLVED_SRC], // handle channel → slot 'source'
      getAssetNeeds: () => SINGLE_SOURCE_NEEDS, // and it's single-cardinality
    })

    // A single-slot consumer reads index [0], so silently keeping both would
    // hand it whichever channel we ordered first — fail loud instead of
    // dispatching the wrong image.
    await expect(
      ctx.step({
        patternId: 'image-to-image' as PatternId,
        input: { references: { source: 'image_1' } },
        assets: [internalSource], // internal channel → same slot 'source'
      }),
    ).rejects.toThrow(/DUAL_SOURCE_SINGLE_SLOT/)
  })

  it('with two single-cardinality slots declared, only the actually-clashing slot throws', async () => {
    // Both 'source' and 'mask' are single-cardinality. 'source' is fed by BOTH
    // channels (handle + internal) → clash; 'mask' is fed by the internal
    // channel only → no clash. The guard keys per-slot, so it must throw for
    // 'source' specifically and never treat 'mask' as a violation.
    const internalSource: ResolvedAssetRef = { slot: 'source', assetId: 'internal-src', modality: 'image' }
    const internalMask: ResolvedAssetRef = { slot: 'mask', assetId: 'internal-mask', modality: 'image' }
    const { ctx } = buildCtx({
      resolve: () => [RESOLVED_SRC], // handle channel fills only 'source'
      getAssetNeeds: () => TWO_SINGLE_SLOT_NEEDS,
    })

    await expect(
      ctx.step({
        patternId: 'image-to-image' as PatternId,
        input: { references: { source: 'image_1' } },
        assets: [internalSource, internalMask],
      }),
    ).rejects.toThrow(/DUAL_SOURCE_SINGLE_SLOT: slot "source"/)
  })

  it('keeps both channels for an array-cardinality slot (best-of-n judge relies on it)', async () => {
    const internalSource: ResolvedAssetRef = {
      slot: 'source',
      assetId: 'internal-src',
      modality: 'image',
    }
    const { ctx, childSpecs } = buildCtx({
      resolve: () => [RESOLVED_SRC],
      getAssetNeeds: () => ARRAY_SOURCE_NEEDS, // array → dual-source is legitimate
    })

    await ctx.step({
      patternId: 'image-to-text' as PatternId,
      input: { references: { source: 'image_1' } },
      assets: [internalSource],
    })

    // Array slot → the resolved reference leads, the internal candidate follows;
    // the guard stays silent (this is exactly best-of-n's judge shape).
    expect(childSpecs[0]?.assets).toEqual([RESOLVED_SRC, internalSource])
  })

  it('does not throw for a single slot when only one channel fills it', async () => {
    // Guard is scoped to *dual*-source: a single slot fed by just the handle
    // channel (no internal ref.assets on it) is the normal i2i case.
    const { ctx, childSpecs } = buildCtx({
      resolve: () => [RESOLVED_SRC],
      getAssetNeeds: () => SINGLE_SOURCE_NEEDS,
    })

    await ctx.step({
      patternId: 'image-to-image' as PatternId,
      input: { references: { source: 'image_1' } },
    })

    expect(childSpecs[0]?.assets).toEqual([RESOLVED_SRC])
  })

  it('degrades to the internal channel only when no resolver is injected', async () => {
    const internal: ResolvedAssetRef = { slot: 'source', assetId: 'internal', modality: 'image' }
    const { ctx, childSpecs } = buildCtx({}) // no resolveStepReferences

    await ctx.step({
      patternId: 'image-to-image' as PatternId,
      input: { references: { source: 'image_1' } },
      assets: [internal],
    })

    // Only the internal channel reaches the child.
    expect(childSpecs[0]?.assets).toEqual([internal])
  })

  it('omits spec.assets entirely when neither channel yields refs', async () => {
    const { ctx, childSpecs } = buildCtx({ resolve: () => [] })

    await ctx.step({
      patternId: 'text-to-image' as PatternId,
      input: { prompt: 'a sunset' },
    })

    expect(childSpecs[0] && 'assets' in childSpecs[0]).toBe(false)
  })

  it('propagates spec.assetContextId into nested child specs (ledger context survives the tree)', async () => {
    const { ctx, childSpecs } = buildCtx({
      resolve: () => [],
      sessionId: 'sess-1',
      assetContextId: 'run-42',
    })

    await ctx.step({
      patternId: 'text-to-image' as PatternId,
      input: { prompt: 'a sunset' },
    })

    // A nested meta child must keep resolving against the ORIGINAL dispatch's
    // ledger (agent runId), never fall back to the session namespace mid-tree.
    expect(childSpecs[0]?.assetContextId).toBe('run-42')
    expect(childSpecs[0]?.sessionId).toBe('sess-1')
  })

  it('propagates a fail-closed resolver throw out of ctx.step (no silent zero-source)', async () => {
    const { ctx } = buildCtx({
      resolve: () => {
        const e = new Error('ASSET_RESOLUTION_FAILED') as Error & { error?: unknown }
        e.error = { code: 'HANDLE_NOT_FOUND', handle: 'image_99' }
        throw e
      },
    })

    await expect(
      ctx.step({
        patternId: 'image-to-image' as PatternId,
        input: { references: { source: 'image_99' } },
      }),
    ).rejects.toThrow(/ASSET_RESOLUTION_FAILED/)
  })

  it('names internally-covered slots to the resolver so its omitted-slot default cannot fire', async () => {
    // A meta feeding a required slot machine-to-machine (ref.assets) passes no
    // references for it. The resolver must be told the slot is already covered
    // — the runtime wiring uses this to skip the "latest of modality" default
    // that would otherwise merge an unrelated ledger asset in.
    const seen: Array<ReadonlySet<string>> = []
    const { ctx, childSpecs } = buildCtx({
      resolve: (_patternId, _input, coveredSlots) => {
        seen.push(coveredSlots)
        return [] // wiring filtered every need → nothing to resolve
      },
    })
    await ctx.step({
      patternId: 'image-to-text' as PatternId,
      input: {},
      assets: [{ slot: 'source', assetId: 'internal-1', modality: 'image' }],
    })
    expect(seen).toHaveLength(1)
    expect([...seen[0]!]).toEqual(['source'])
    // Child receives exactly the internal channel — no defaulted extras.
    expect(childSpecs[0]!.assets).toEqual([
      { slot: 'source', assetId: 'internal-1', modality: 'image' },
    ])
  })
})
