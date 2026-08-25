import { describe, expect, it } from 'vitest'

import type { ExecutionContext, StepOptions, PatternRef } from '@orchestral/core'
import { createImageBestOfNMeta, ImageBestOfNOutputSchema } from '../meta/image-best-of-n'
import { byLabel, expectProducedAssetsEnvelope } from './helpers/produced-assets'
import { BEST_OF_N_IMAGE_JUDGE_PROMPT } from '../meta/image-best-of-n/prompts'

// Recorded shape for each ctx.step invocation — used by tests to assert
// fan-out behaviour, stepId override (idempotency-cache bypass), and the
// inputs / internal-asset refs sent to the judge.
interface RecordedStep {
  patternId: string
  input: unknown
  assets: PatternRef['assets']
  stepOptions: StepOptions | undefined
}

/**
 * Fake ExecutionContext.
 *
 * The first `n` step calls are treated as image-gen candidates (return an
 * `assets[]` shape). The (n+1)-th call is the judge — returns
 * `{modality, text, cost, latencyMs, model, provider}` with `text` = the
 * judge JSON string.
 *
 * Each candidate gets a deterministic assetId (`asset-cand-${idx}`) so tests
 * can assert the winning assetId without coupling to a specific seed.
 */
function makeCtx(opts: {
  n: number
  judgeJson: string
  candidateCosts?: readonly number[]
}) {
  const recorded: RecordedStep[] = []
  let candidateIdx = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      recorded.push({
        patternId: ref.patternId,
        input: ref.input,
        assets: ref.assets,
        stepOptions: options,
      })
      if (candidateIdx < opts.n) {
        const idx = candidateIdx++
        return {
          modality: 'image',
          assets: [{ assetId: `asset-cand-${idx}` }],
          cost: opts.candidateCosts?.[idx] ?? 1,
          latencyMs: 100,
          model: 'test:t2i',
          provider: 'test',
        } as unknown as T
      }
      return {
        modality: 'text',
        text: opts.judgeJson,
        cost: 2,
        latencyMs: 50,
        model: 'test:vlm',
        provider: 'test',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, recorded }
}

describe('meta_image-best-of-n', () => {
  it('fans out N candidates with unique stepId, judges, and returns the winner', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx, recorded } = makeCtx({
      n: 3,
      judgeJson: JSON.stringify({
        best_image_index: 1,
        reason: 'best character match',
      }),
    })

    const out = await meta.compose(
      {
        input: {
          innerPatternId: 'text-to-image',
          innerInput: { prompt: 'a knight', n: 1 },
          n: 3,
          targetDescription: 'a knight in shining armor',
        },
      },
      ctx,
    )

    // 3 fan-out calls + 1 judge call.
    expect(recorded).toHaveLength(4)

    // Each fan-out hits text-to-image with a unique stepId — without this
    // override the stepCache would collapse N identical dispatches into one
    // and we'd lose sample diversity.
    expect(recorded[0]!.patternId).toBe('text-to-image')
    expect(recorded[0]!.stepOptions?.stepId).toBe('candidate-0')
    expect(recorded[1]!.stepOptions?.stepId).toBe('candidate-1')
    expect(recorded[2]!.stepOptions?.stepId).toBe('candidate-2')

    // Judge is image-to-text with the inlined judge prompt as system. The three
    // candidates flow by assetId through the internal-asset channel (ref.assets,
    // slot 'source'), NOT input.references — that channel is reserved for
    // caller-authored reference handles.
    expect(recorded[3]!.patternId).toBe('image-to-text')
    const judgeInput = recorded[3]!.input as {
      system: string
      references?: { source: readonly string[] }
      responseFormat: string
      jsonSchema: unknown
    }
    expect(judgeInput.system).toBe(BEST_OF_N_IMAGE_JUDGE_PROMPT)
    // No caller references → no input.references at all (only the assets channel).
    expect(judgeInput.references).toBeUndefined()
    expect(recorded[3]!.assets).toEqual([
      { slot: 'source', assetId: 'asset-cand-0', modality: 'image' },
      { slot: 'source', assetId: 'asset-cand-1', modality: 'image' },
      { slot: 'source', assetId: 'asset-cand-2', modality: 'image' },
    ])
    expect(judgeInput.responseFormat).toBe('json')
    expect(judgeInput.jsonSchema).toBeDefined()

    // Winner = candidate 1 (per judgeJson); every candidate is kept in
    // submission order for human review, the pick carrying the `winner` label.
    expect(out.assets).toEqual([
      { assetId: 'asset-cand-0', modality: 'image', label: 'candidate' },
      { assetId: 'asset-cand-1', modality: 'image', label: 'winner' },
      { assetId: 'asset-cand-2', modality: 'image', label: 'candidate' },
    ])
    expect(out.reason).toBe('best character match')

    // cost = 3 image-gen × 1 + 1 judge × 2 = 5. latency = max(100,100,100) + 50.
    expect(out.cost).toBe(5)
    expect(out.latencyMs).toBe(150)
  })

  it('prepends reference images to the judge source and labels them, keeping best_image_index candidate-relative', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx, recorded } = makeCtx({
      n: 2,
      // candidate-relative index 1 → cand-1
      judgeJson: JSON.stringify({
        best_image_index: 1,
        reason: 'matches the reference hairstyle',
      }),
    })

    const out = await meta.compose(
      {
        input: {
          innerPatternId: 'text-to-image',
          innerInput: { prompt: 'a knight', n: 1 },
          n: 2,
          targetDescription: 'a knight matching the reference',
          referenceHandles: ['ref-portrait-0', 'ref-portrait-1'],
          refDescriptions: ['protagonist front view', 'protagonist side view'],
        },
      },
      ctx,
    )

    const judgeStep = recorded.find((r) => r.patternId === 'image-to-text')!
    const judgeInput = judgeStep.input as {
      prompt: string
      references?: { source: readonly string[] }
    }

    // This mock ctx does NOT run the runtime merge, so `assets` here is only
    // what the meta EMITS on the internal channel: the candidates by assetId
    // (ref.assets), slot 'source'. The caller-authored referenceHandles ride
    // the LLM-facing handle channel (input.references.source, asserted below).
    // At dispatch the host resolves those handles (via the judge's image-to-text
    // `source` assetNeeds) and buildMetaExecutionContext merges them into the
    // same 'source' slot AHEAD of the candidates — proven end-to-end through the
    // real merge in orchestral-runtime's meta-image-best-of-n-references.test.ts.
    expect(judgeStep.assets).toEqual([
      { slot: 'source', assetId: 'asset-cand-0', modality: 'image' },
      { slot: 'source', assetId: 'asset-cand-1', modality: 'image' },
    ])
    expect(judgeInput.references?.source).toEqual([
      'ref-portrait-0',
      'ref-portrait-1',
    ])

    // Prompt labels: one "Reference Image i:" per actual reference image
    // (with caption), then "Generated Image i" per candidate.
    expect(judgeInput.prompt).toContain(
      'Reference Image 0: protagonist front view',
    )
    expect(judgeInput.prompt).toContain(
      'Reference Image 1: protagonist side view',
    )
    expect(judgeInput.prompt).toContain('Generated Image 0')
    expect(judgeInput.prompt).toContain('Generated Image 1')
    // Candidate-relative index reinforcement present when refs prepended.
    expect(judgeInput.prompt).toContain(
      'index among the Generated Images only',
    )

    // best_image_index=1 is candidate-relative → asset-cand-1.
    expect(byLabel(out, 'winner')?.assetId).toBe('asset-cand-1')
  })

  it('labels references with (no caption) when refDescriptions is shorter than referenceHandles', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx, recorded } = makeCtx({
      n: 2,
      judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
    })

    await meta.compose(
      {
        input: {
          innerPatternId: 'text-to-image',
          innerInput: { prompt: 'x' },
          n: 2,
          targetDescription: 'target',
          referenceHandles: ['ref-0', 'ref-1'],
          refDescriptions: ['only one caption'], // shorter than handles
        },
      },
      ctx,
    )

    const judgePrompt = String(
      (recorded.find((r) => r.patternId === 'image-to-text')!.input as {
        prompt: string
      }).prompt,
    )
    expect(judgePrompt).toContain('Reference Image 0: only one caption')
    // Second reference image still labelled (count driven by handles, not captions).
    expect(judgePrompt).toContain('Reference Image 1: (no caption)')
  })

  it('routes through image-to-image when innerPatternId is image-to-image', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx, recorded } = makeCtx({
      n: 2,
      judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
    })

    await meta.compose(
      {
        input: {
          innerPatternId: 'image-to-image',
          innerInput: { prompt: 'tweak the sky', references: { source: 'h0' } },
          n: 2,
          targetDescription: 'sunset variant',
        },
      },
      ctx,
    )

    expect(recorded[0]!.patternId).toBe('image-to-image')
    expect(recorded[1]!.patternId).toBe('image-to-image')
    // The inner input is forwarded verbatim — i2i ref handle survives.
    expect(recorded[0]!.input).toMatchObject({
      prompt: 'tweak the sky',
      references: { source: 'h0' },
    })
  })

  it('keeps cost finite when one candidate reports NaN (sumCosts guard)', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx } = makeCtx({
      n: 2,
      judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
      candidateCosts: [Number.NaN, 1],
    })

    const out = await meta.compose(
      {
        input: {
          innerPatternId: 'text-to-image',
          innerInput: { prompt: 'a knight' },
          n: 2,
          targetDescription: 'a knight',
        },
      },
      ctx,
    )

    // The NaN candidate is guarded to 0 — 1 finite candidate + judge (2).
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBe(3)
  })

  it('throws when the judge returns an out-of-range index — no silent fallback', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx } = makeCtx({
      n: 2,
      judgeJson: JSON.stringify({
        best_image_index: 5, // ≥ n
        reason: 'I picked one that does not exist',
      }),
    })

    await expect(
      meta.compose(
        {
          input: {
            innerPatternId: 'text-to-image',
            innerInput: { prompt: 'a knight' },
            n: 2,
            targetDescription: 'a knight',
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/best_image_index=5 but only 2 candidates/)
  })

  it('throws if an inner image-gen returns no assets — refuses to judge an empty set', async () => {
    const meta = createImageBestOfNMeta()
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(): Promise<T> =>
        ({
          modality: 'image',
          assets: [], // empty
          cost: 0,
          latencyMs: 0,
          model: 'test',
          provider: 'test',
        }) as unknown as T,
    } as unknown as ExecutionContext

    await expect(
      meta.compose(
        {
          input: {
            innerPatternId: 'text-to-image',
            innerInput: { prompt: 'broken' },
            n: 2,
            targetDescription: 'irrelevant',
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/inner image-gen produced no asset/)
  })

  it('declares a meta Pattern with a stable id, kind, and tool surface', () => {
    const meta = createImageBestOfNMeta()
    expect(meta.id).toBe('meta_image-best-of-n')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.searchHint).toContain('multiple image candidates')
    expect(meta.tool.description).toBeTruthy()
  })

  it('returns the produced-assets envelope: every candidate labelled, no raw-id field and no allCandidates', async () => {
    const meta = createImageBestOfNMeta()
    const { ctx } = makeCtx({
      n: 2,
      judgeJson: JSON.stringify({ best_image_index: 0, reason: 'ok' }),
    })
    const out = await meta.compose(
      {
        input: {
          innerPatternId: 'text-to-image',
          innerInput: { prompt: 'x' },
          n: 2,
          targetDescription: 'x',
        },
      },
      ctx,
    )
    expectProducedAssetsEnvelope(ImageBestOfNOutputSchema, out)
    expect(out).not.toHaveProperty('allCandidates')
    expect(out.assets.map((a) => a.label)).toEqual(['winner', 'candidate'])
  })

  it('declares the dispatch set an agent guard holds to its allowlist', () => {
    const meta = createImageBestOfNMeta()
    const call = (innerPatternId: 'text-to-image' | 'image-to-image') =>
      meta.plannedDispatches?.({
        innerPatternId,
        innerInput: { prompt: 'a red bicycle' },
        n: 2,
        targetDescription: 'a red bicycle',
      })
    // The fan-out id is the caller's, the judge's is this meta's own.
    expect(call('text-to-image')).toEqual(['text-to-image', 'image-to-text'])
    expect(call('image-to-image')).toEqual(['image-to-image', 'image-to-text'])

    // Defensive: the declaration runs on the dispatch path, where a
    // host-direct submit never parsed the input against `tool.inputs`. It must
    // not throw, and it answers what `dispatchInner` would actually do with a
    // missing / unknown id — anything but 'text-to-image' renders through i2i.
    for (const malformed of [undefined, null, {}, { innerPatternId: 'nonsense' }]) {
      expect(meta.plannedDispatches?.(malformed as never)).toEqual([
        'image-to-image',
        'image-to-text',
      ])
    }
  })
})
