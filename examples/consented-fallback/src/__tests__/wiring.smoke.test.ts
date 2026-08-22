// Wiring smoke test — proves every beat of main.ts on the same mock models it
// runs on by default, with the stdin AskUserHandler replaced by one that
// auto-answers. Same registry → router → runtime path; only the handler and
// the observer differ.
//
//   explain  — the router reports image-to-image as no-model-in-catalog
//   refuse   — default runtime: ALTERNATIVES_NOT_ENABLED, via-caption named,
//              no model called
//   ask/yes  — the caption path runs ON THE SOURCE IMAGE and the output says
//              degraded; ask/no — declined cleanly, nothing dispatched
//   auto     — `alternatives: 'auto'` redirects, announces the losses on
//              job:alternative-selected, and completes in image-to-image's shape

import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultCapabilityRouter,
  InMemoryJobStore,
  PatternRegistry,
  type Alternative,
  type AskUserHandler,
  type AskUserRequest,
  type JobEvent,
} from '@orchestral/core'
import {
  createImageToImagePattern,
  createImageToImageViaCaptionPattern,
  createImageToTextPattern,
  createTextToImagePattern,
  IMAGE_TO_IMAGE_PATTERN_ID,
  IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
  ImageToImageOutputSchema,
  type ImageToImageInput,
  type ImageToImageOutput,
} from '@orchestral/patterns'
import { InlineRuntime } from '@orchestral/runtime'
import { createModels } from '../ai-sdk-wiring'
import { HostAssetStore } from '../asset-store'
import {
  CONSENTED_EDIT_PATTERN_ID,
  ConsentedEditOutputSchema,
  createConsentedEditPattern,
  type ConsentedEditInput,
  type ConsentedEditOutput,
} from '../consented-edit'
import { MOCK_CAPTION, mockCaptionModel, mockImageModel, PNG_B64 } from '../mocks'

const EDIT = 'make it night, keep the bicycle'

function harness(init: { alternatives?: 'auto' | 'off'; askUser?: AskUserHandler } = {}) {
  // Identical wiring to src/main.ts: the host store holds the upload, the two
  // mocks are the catalog, image-to-image has no model.
  const assets = new HostAssetStore()
  const source = {
    slot: 'source',
    assetId: assets.put('upload-1', { mime: 'image/png', base64: PNG_B64 }),
    modality: 'image' as const,
  }
  const caption = mockCaptionModel()
  const imageGen = vi.fn(async () => ({
    images: [PNG_B64],
    warnings: [] as never[],
    response: { timestamp: new Date(0), modelId: 'mock-image', headers: {} },
  }))
  const image = mockImageModel()
  image.doGenerate = imageGen

  const registry = new PatternRegistry()
  registry.add(createTextToImagePattern())
  registry.add(createImageToTextPattern())
  registry.add(createImageToImagePattern())
  registry.add(createImageToImageViaCaptionPattern())
  const path = registry
    .getEntry(IMAGE_TO_IMAGE_PATTERN_ID)!
    .alternatives.find((alt) => alt.id === 'via-caption') as Alternative<
    ImageToImageInput,
    ImageToImageOutput
  >
  registry.add(createConsentedEditPattern({ path }))

  const router = createDefaultCapabilityRouter({
    getModels: createModels(
      {
        image: { provider: 'mock', modelId: 'mock-image', model: image },
        caption: { provider: 'mock', modelId: 'mock-vlm', model: caption },
      },
      assets,
    ),
  })

  const events: JobEvent[] = []
  const jobIds: string[] = []
  const runtime: InlineRuntime = new InlineRuntime({
    store: new InMemoryJobStore(),
    registry,
    router,
    ...(init.alternatives ? { alternatives: init.alternatives } : {}),
    ...(init.askUser ? { askUser: init.askUser } : {}),
    onJobCreated: (jobId) => {
      jobIds.push(jobId)
      runtime.subscribe(jobId, (ev) => events.push(ev))
    },
  })
  return { assets, source, caption, imageGen, registry, router, runtime, events, jobIds, path }
}

/** An auto-answering host: records the question, answers `confirmed`. */
function autoAnswer(confirmed: boolean) {
  const seen: AskUserRequest[] = []
  const handler: AskUserHandler = async (request) => {
    seen.push(request)
    return { confirmed }
  }
  return { handler, seen }
}

describe('consented-fallback wiring', () => {
  it('explain: the router reports image-to-image as no-model-in-catalog', () => {
    const { router } = harness()
    const explanation = router.explain?.(IMAGE_TO_IMAGE_PATTERN_ID)
    expect(explanation).toBeDefined()
    expect(explanation!.satisfiable).toBe(false)
    expect(explanation!.candidates).toEqual([])
    expect(explanation!.outcome).toEqual({ kind: 'no-candidate', reason: 'no-model-in-catalog' })
    // The catalog does serve the two neighbours the fallback is built on.
    expect(router.explain?.('text-to-image')?.outcome.kind).toBe('selected')
    expect(router.explain?.('image-to-text')?.outcome.kind).toBe('selected')
  })

  it('default: refuses with ALTERNATIVES_NOT_ENABLED and names via-caption, calling no model', async () => {
    const { runtime, source, events, jobIds, imageGen, caption, path } = harness()

    // A dispatch that ran and failed is data: `submitJob` resolves with the
    // errored row, the JobError on it.
    const job = await runtime.submitJob({
      patternId: IMAGE_TO_IMAGE_PATTERN_ID,
      input: { prompt: EDIT },
      assets: [source],
    })
    expect(job.id).toBe(jobIds[0])
    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('ALTERNATIVES_NOT_ENABLED')
    const diagnostic = (job.error?.details as { diagnostic: Record<string, unknown> }).diagnostic
    expect(diagnostic.capability).toBe('image-to-image')
    expect(diagnostic.reason).toBe('no-model-in-catalog')
    // The refusal carries the trade-off itself — the host does not go back to
    // the registry to learn what the path it was offered would lose.
    expect(diagnostic.alternatives).toEqual([
      {
        id: 'via-caption',
        description: path.description,
        targetPatternId: IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
        preserves: ['style'],
        losses: ['subject-identity', 'composition', 'mask-guidance'],
      },
    ])

    // Nothing ran behind the caller's back.
    expect(imageGen).not.toHaveBeenCalled()
    expect(caption.doGenerateCalls).toHaveLength(0)
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)
    expect(events.some((e) => e.type === 'job:failed')).toBe(true)
  })

  it('ask → yes: the caption path runs on the source image and the output says degraded', async () => {
    const { handler, seen } = autoAnswer(true)
    const { runtime, source, assets, caption, imageGen, events, path } = harness({ askUser: handler })

    const job = await runtime.submitJob<ConsentedEditInput, ConsentedEditOutput>({
      patternId: CONSENTED_EDIT_PATTERN_ID,
      input: { prompt: EDIT },
      assets: [source],
    })
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()

    // The question was the declaration, in words.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe('confirm')
    expect(seen[0]!.jobId).toBe(job.id)
    const payload = seen[0]!.payload as { title: string; body: string }
    expect(payload.title).toContain("'via-caption'")
    expect(payload.body).toContain(path.description)
    expect(payload.body).toContain('Loses: subject identity, composition, mask guidance.')

    // The output satisfies the meta's own (bounded) schema.
    const output = ConsentedEditOutputSchema.parse(job.output)
    expect(output.outcome).toBe('edited')
    expect(output.degraded).toBe(true)
    expect(output.assets).toHaveLength(1)
    // …and the produced asset is real: the host store can hand back its bytes.
    expect(assets.dataUri(output.assets[0]!.assetId)).toBe(`data:image/png;base64,${PNG_B64}`)

    // The chain ran in order, on the right image: the mock VLM was sent the
    // upload's PNG bytes as an image part, and the render step asked for the
    // draft size via-caption requests.
    expect(caption.doGenerateCalls).toHaveLength(1)
    const userMessage = caption.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!
    const fileParts = userMessage.content.filter((part) => part.type === 'file')
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0]).toMatchObject({ type: 'file', mediaType: 'image/png' })
    expect(imageGen).toHaveBeenCalledOnce()
    const renderOptions = imageGen.mock.calls[0]![0 as never] as { prompt: string; size?: string }
    expect(renderOptions.size).toBe('1024x1024')
    expect(renderOptions.prompt).toContain(MOCK_CAPTION)
    expect(renderOptions.prompt).toContain(EDIT)

    // Each sub-step settled on the root job's stream (no redirect event: the
    // host took the path, the runtime did not).
    const steps = events.filter((e) => e.type === 'job:step')
    expect(steps.map((e) => (e.type === 'job:step' ? e.patternId : ''))).toEqual([
      'image-to-text',
      'text-to-image',
      IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID,
    ])
    expect(events.some((e) => e.type === 'job:alternative-selected')).toBe(false)
  })

  it('ask → no: declines cleanly and dispatches nothing', async () => {
    const { handler, seen } = autoAnswer(false)
    const { runtime, source, caption, imageGen, events } = harness({ askUser: handler })

    const job = await runtime.submitJob<ConsentedEditInput, ConsentedEditOutput>({
      patternId: CONSENTED_EDIT_PATTERN_ID,
      input: { prompt: EDIT },
      assets: [source],
    })
    expect(job.status).toBe('done')
    expect(seen).toHaveLength(1)

    const output = ConsentedEditOutputSchema.parse(job.output)
    expect(output).toMatchObject({ outcome: 'declined', assets: [], degraded: false, cost: 0 })
    expect(caption.doGenerateCalls).toHaveLength(0)
    expect(imageGen).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'job:step')).toBe(false)
  })

  it("auto: alternatives: 'auto' redirects, announces the losses, and completes in image-to-image's shape", async () => {
    const { runtime, source, events, caption, imageGen } = harness({ alternatives: 'auto' })

    const job = await runtime.submitJob<ImageToImageInput, ImageToImageOutput>({
      patternId: IMAGE_TO_IMAGE_PATTERN_ID,
      input: { prompt: EDIT },
      assets: [source],
    })
    expect(job.status).toBe('done')

    // The degradation notice, before the redirect ran.
    const selected = events.filter((e) => e.type === 'job:alternative-selected')
    expect(selected).toHaveLength(1)
    const ev = selected[0]!
    if (ev.type !== 'job:alternative-selected') throw new Error('unreachable')
    expect(ev.alternativeId).toBe('via-caption')
    expect(ev.targetPatternId).toBe(IMAGE_TO_IMAGE_VIA_CAPTION_PATTERN_ID)
    expect(ev.preserves).toEqual(['style'])
    expect(ev.losses).toEqual(['subject-identity', 'composition', 'mask-guidance'])
    const types = events.map((e) => e.type)
    expect(types.indexOf('job:alternative-selected')).toBeLessThan(types.indexOf('job:completed'))

    // The chain ran on the source image, and the output is the PARENT's shape —
    // no `degraded` flag; the event above is the notice.
    expect(caption.doGenerateCalls).toHaveLength(1)
    expect(imageGen).toHaveBeenCalledOnce()
    const output = ImageToImageOutputSchema.parse(job.output)
    expect(output.assets).toHaveLength(1)
    expect(output.model).toBe('mock:mock-image')
    expect(output).not.toHaveProperty('degraded')
  })
})
