// Host-local ai-sdk wiring — two `ModelCapability.call` bridges, one per
// model this host serves. core / runtime / patterns never import a provider
// SDK; talking to one is host territory, and this file is the whole of it:
//
//   • text-to-image  → ai-sdk `generateImage`  (same bridge as atomic-hello-world,
//                      plus the `size` / `n` params a meta fills directly)
//   • image-to-text  → ai-sdk `generateText` over a vision-capable language
//                      model, the source image(s) read from the host asset store
//
// There is deliberately NO image-to-image bridge. That gap is what main.ts is
// about. Both bridges take a model INSTANCE the host built (a real
// `openai.image(...)` / `openai(...)`, or an `ai/test` mock) so the same code
// runs offline and live.

import { generateImage, generateText } from 'ai'
import type {
  CallEvents,
  Capability,
  DispatchContext,
  DispatchResult,
  ModelCapability,
} from '@orchestral/core'
import { MODEL_SPEC_VERSION } from '@orchestral/core'
import type { HostAssetStore } from './asset-store'

// The resolved model OBJECT types, pulled out of the ai-sdk call signatures
// (avoids a transitive `@ai-sdk/provider` import). `generateImage` /
// `generateText` also accept a bare provider-registry id string; the bridges
// need the instance, because they read `.provider` / `.modelId` off it.
type ImageModelInstance = Exclude<
  Parameters<typeof generateImage>[0]['model'],
  string
>
type LanguageModelInstance = Exclude<
  Parameters<typeof generateText>[0]['model'],
  string
>

/** One model the host serves, with its own ai-sdk instance (BYOK). */
export interface ModelSpec<M> {
  provider: string
  modelId: string
  model: M
}

/** The two models this host has. Nothing for image-to-image, on purpose. */
export interface HostModels {
  image: ModelSpec<ImageModelInstance>
  caption: ModelSpec<LanguageModelInstance>
}

function readString(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(input: unknown, key: string): number | undefined {
  const value = (input as Record<string, unknown> | null)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ── text-to-image ───────────────────────────────────────────────────────────

/**
 * Bridge an ai-sdk ImageModel to `ModelCapability.call`. Reads `prompt` plus
 * the top-level `ImageGenerationParams` (`size` / `n` / `seed` /
 * `aspectRatio`) — the channel a meta `compose()` fills directly, and the
 * one text-to-image's contract says an adapter must honour rather than
 * silently rendering at its own default. Produced images are recorded into
 * the host store; the output carries their ids (plus a data-URI `url`, since
 * this host has no public asset URLs) in patterns' TextToImageOutput shape.
 */
function imageCall(
  model: ImageModelInstance,
  store: HostAssetStore,
): ModelCapability['call'] {
  return async function aiSdkImageCall<I, O>(
    input: I,
    ctx: DispatchContext,
    events?: CallEvents,
  ): Promise<DispatchResult<O>> {
    const prompt = readString(input, 'prompt')
    if (!prompt) {
      throw new Error('text-to-image call: input.prompt (non-empty string) is required')
    }
    const size = readString(input, 'size')
    const aspectRatio = readString(input, 'aspectRatio')

    const startedAt = Date.now()
    const { images } = await generateImage({
      model,
      prompt,
      ...(readNumber(input, 'n') !== undefined ? { n: readNumber(input, 'n') } : {}),
      // ai-sdk types these as template literals; the pattern contract says
      // "WIDTHxHEIGHT" / "W:H", so a string that matches the shape passes through.
      ...(size && /^\d+x\d+$/.test(size) ? { size: size as `${number}x${number}` } : {}),
      ...(aspectRatio && /^\d+:\d+$/.test(aspectRatio)
        ? { aspectRatio: aspectRatio as `${number}:${number}` }
        : {}),
      ...(readNumber(input, 'seed') !== undefined ? { seed: readNumber(input, 'seed') } : {}),
      abortSignal: ctx.signal,
    })

    const latencyMs = Date.now() - startedAt
    const produced = (images ?? []).filter((img) => !!img?.base64)
    if (produced.length === 0) {
      throw new Error(`${model.provider}: ai-sdk image generation returned no images`)
    }

    const assets = produced.map((img) => {
      const mime = img.mediaType || 'image/png'
      const assetId = store.record({ mime, base64: img.base64 })
      const uri = store.dataUri(assetId)
      events?.onArtifact?.({ kind: 'image', uri, mime })
      return { assetId, modality: 'image' as const, url: uri }
    })

    const output = {
      modality: 'image' as const,
      assets,
      cost: 0,
      latencyMs,
      model: `${model.provider}:${model.modelId}`,
      provider: model.provider,
    }
    return { output: output as O }
  }
}

// ── image-to-text ───────────────────────────────────────────────────────────

const MODE_SYSTEM: Record<string, string> = {
  caption: 'Write a one-line caption for the image.',
  describe: 'Describe the image in detail.',
  judge: 'Evaluate the image against the instruction and explain your verdict.',
  'extract-style': 'Describe the visual style of the image: medium, palette, lighting, composition.',
}

/**
 * Bridge a vision-capable ai-sdk LanguageModel to `ModelCapability.call` for
 * image-to-text. The source image(s) arrive as assetIds on `ctx.assets`
 * (slot `source`, declared array-cardinality — every ref is sent, in order);
 * the adapter turns each id into bytes through the host store, because the
 * runtime only ever passes ids. `system` / `prompt` / `mode` / `maxLength`
 * follow the pattern's input contract; `responseFormat: 'json'` is not
 * wired here (this host never asks for it).
 */
function captionCall(
  model: LanguageModelInstance,
  store: HostAssetStore,
): ModelCapability['call'] {
  return async function aiSdkCaptionCall<I, O>(
    input: I,
    ctx: DispatchContext,
  ): Promise<DispatchResult<O>> {
    const sources = (ctx.assets ?? []).filter((a) => a.slot === 'source')
    if (sources.length === 0) {
      throw new Error('image-to-text call: no `source` asset on ctx.assets')
    }
    const mode = readString(input, 'mode') ?? 'caption'
    const system = readString(input, 'system') ?? MODE_SYSTEM[mode] ?? MODE_SYSTEM.caption
    const text = readString(input, 'prompt') ?? system
    const maxLength = readNumber(input, 'maxLength')

    const startedAt = Date.now()
    const result = await generateText({
      model,
      ...(system ? { system } : {}),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            // ai-sdk's `file` part, raw base64 plus the media type — the id
            // the runtime passed becomes bytes only here, in the host.
            ...sources.map((ref) => {
              const { mime, base64 } = store.get(ref.assetId)
              return { type: 'file' as const, data: base64, mediaType: mime }
            }),
          ],
        },
      ],
      abortSignal: ctx.signal,
    })

    const output = {
      modality: 'text' as const,
      // `maxLength` is a soft cap in characters per the pattern's contract.
      text: maxLength ? result.text.slice(0, maxLength) : result.text,
      cost: 0,
      latencyMs: Date.now() - startedAt,
      model: `${model.provider}:${model.modelId}`,
      provider: model.provider,
    }
    return { output: output as O }
  }
}

// ── getModels ───────────────────────────────────────────────────────────────

/**
 * Pack the host's two models into the `getModels(cap)` the default router
 * consumes. Each becomes a `ModelCapability` envelope declaring exactly one
 * capability; asking for any other capability — image-to-image included —
 * returns `[]`, which is what the router reports as `no-model-in-catalog`.
 */
export function createModels(
  models: HostModels,
  store: HostAssetStore,
): (cap: Capability) => readonly ModelCapability[] {
  const envelopes: ModelCapability[] = [
    {
      specificationVersion: MODEL_SPEC_VERSION,
      capabilities: ['text-to-image'],
      provider: models.image.provider,
      modelId: models.image.modelId,
      inputs: ['text'],
      outputs: ['image'],
      tags: [],
      source: 'user',
      call: imageCall(models.image.model, store),
    },
    {
      specificationVersion: MODEL_SPEC_VERSION,
      capabilities: ['image-to-text'],
      provider: models.caption.provider,
      modelId: models.caption.modelId,
      inputs: ['image', 'text'],
      outputs: ['text'],
      tags: [],
      source: 'user',
      call: captionCall(models.caption.model, store),
    },
  ]
  return (cap) => envelopes.filter((env) => env.capabilities.includes(cap))
}
