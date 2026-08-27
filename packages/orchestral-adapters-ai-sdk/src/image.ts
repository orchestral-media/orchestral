// text-to-image over the AI SDK's `generateImage`.

import { generateImage, type ImageModel } from 'ai'
import type {
  Artifact,
  CallEvents,
  DispatchContext,
  DispatchResult,
  ModelCapability,
} from '@orchestral/core'

import {
  type AdapterOptions,
  asRecord,
  buildRecord,
  dispatchEnvelope,
  mintAssetIds,
  optionalNumber,
  optionalString,
  providerOptionsFor,
  requireString,
  resolveIdentity,
} from './envelope'

/**
 * A resolved AI SDK image model OBJECT — `ImageModel` minus the bare-id string
 * form that only helpers backed by a provider registry accept. The adapter
 * reads `.provider` / `.modelId` off it and hands it to `generateImage`.
 * Build one with `openai.image('gpt-image-1')` (or any provider's `.image()`).
 */
export type ImageModelInstance = Exclude<ImageModel, string>

type ImageSize = NonNullable<Parameters<typeof generateImage>[0]['size']>
type ImageAspectRatio = NonNullable<
  Parameters<typeof generateImage>[0]['aspectRatio']
>

const SIZE_RE = /^\d+x\d+$/
const ASPECT_RE = /^\d+:\d+$/

/**
 * Wrap an AI SDK image model as a `text-to-image` `ModelCapability`.
 *
 * Reads off the input: `prompt` (required), and the `ImageGenerationParams`
 * the first-party pattern documents as the adapter contract — `size`
 * (`WxH`), `aspectRatio` (`W:H`), `n`, `seed` — plus a flat
 * `providerOptions`. Returns a `TextToImageOutput`: one `assets[]` element per
 * generated image, its `assetId` from `options.mintAssetId` (a placeholder by
 * default; no `url` — the bytes arrive as `artifacts` and on the
 * `job:artifact` event, each stamped with the same id on `meta.assetId`),
 * `cost: null`.
 *
 * Not mapped: the `reference` / `control` asset slots (see README).
 */
export function fromImageModel(
  model: ImageModelInstance,
  options: AdapterOptions = {},
): ModelCapability {
  const identity = resolveIdentity(model, options)
  return {
    ...buildRecord(identity, options, {
      capability: 'text-to-image',
      inputs: ['text'],
      outputs: ['image'],
    }),
    async call<I, O>(
      input: I,
      ctx: DispatchContext,
      events?: CallEvents,
    ): Promise<DispatchResult<O>> {
      const fields = asRecord(input)
      const prompt = requireString(fields, 'prompt', 'text-to-image')
      const size = optionalString(fields, 'size')
      if (size !== undefined && !SIZE_RE.test(size)) {
        throw new Error(
          `text-to-image call: input.size must be "WIDTHxHEIGHT" (got ${JSON.stringify(size)})`,
        )
      }
      const aspectRatio = optionalString(fields, 'aspectRatio')
      if (aspectRatio !== undefined && !ASPECT_RE.test(aspectRatio)) {
        throw new Error(
          `text-to-image call: input.aspectRatio must be "W:H" (got ${JSON.stringify(aspectRatio)})`,
        )
      }
      const n = optionalNumber(fields, 'n')
      const seed = optionalNumber(fields, 'seed')
      const providerOptions = providerOptionsFor(identity.sdkProviderKey, ctx, fields)

      const startedAt = Date.now()
      const { images } = await generateImage({
        model,
        prompt,
        ...(size !== undefined ? { size: size as ImageSize } : {}),
        ...(aspectRatio !== undefined
          ? { aspectRatio: aspectRatio as ImageAspectRatio }
          : {}),
        ...(n !== undefined ? { n } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: ctx.signal,
      })

      const produced = images.filter((img) => img.base64.length > 0)
      if (produced.length === 0) {
        throw new Error(
          `${identity.provider}: the AI SDK image model returned no images`,
        )
      }

      const minted = mintAssetIds(
        produced.map((img): Artifact => {
          const mime = img.mediaType || 'image/png'
          return { kind: 'image', uri: `data:${mime};base64,${img.base64}`, mime }
        }),
        ctx,
        events,
        options,
        'text-to-image',
        (i) => `aisdk-image-${i}`,
      )

      // `assetId` is whatever the host's `mintAssetId` answered — by default a
      // placeholder that names nothing in any store — and `url` is left unset
      // rather than filled with the data: URI. The bytes travel on
      // `artifacts` / `events.onArtifact` (the runtime's `job:artifact`
      // event), which is the channel built for them; `producedAssetShape.url`
      // is bounded precisely so a multi-megabyte blob cannot ride in the
      // output a model or a transcript might see.
      const output = {
        modality: 'image' as const,
        assets: minted.map(({ assetId }) => ({
          assetId,
          modality: 'image' as const,
        })),
        ...dispatchEnvelope(identity, startedAt),
      }
      return { output: output as O, artifacts: minted.map((m) => m.artifact) }
    },
  }
}
