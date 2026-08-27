// image-to-text over the AI SDK's `generateText`, on a vision-capable
// language model: the `source` images go up as `file` parts of one user
// message, ahead of the instruction text.

import { type FilePart, generateText } from 'ai'
import type {
  DispatchContext,
  DispatchResult,
  ModelCapability,
  ResolvedAssetRef,
} from '@orchestral/core'

import {
  type AdapterOptions,
  asRecord,
  buildRecord,
  dispatchEnvelope,
  optionalNumber,
  optionalString,
  providerOptionsFor,
  requireSourceAssets,
  resolveIdentity,
} from './envelope'
import type { LanguageModelInstance } from './language'
import { readStructuredOutput, structuredText } from './structured-output'

/**
 * What `loadImage` hands back for one `source` asset:
 *
 * - the image bytes, or a `URL` the AI SDK downloads itself (`https:`,
 *   `file:`, or a `data:` URI — which is what a standalone host's
 *   `text-to-image` output carries). The concrete media type is sniffed from
 *   the bytes by the SDK (`image/png`, `image/jpeg`, `image/webp`, …); the
 *   part is sent as the generic `image` type until it is.
 * - or `{ data, mediaType }` to state the media type yourself — the form a
 *   host whose store keeps base64 alongside its mime wants, since a bare
 *   base64 string is ambiguous with a URL and is accepted only here.
 */
export type ImageSource =
  | Uint8Array
  | ArrayBuffer
  | URL
  | {
      readonly data: Uint8Array | ArrayBuffer | string | URL
      readonly mediaType: string
    }

/**
 * The one thing a vision adapter cannot derive: how to turn each resolved
 * `source` asset into an image. Same posture as `fromTranscriptionModel`'s
 * `loadAudio` — an orchestral `assetId` is an opaque host identifier, and
 * `@orchestral/core` deliberately defines no way to read its bytes, so the
 * host that owns the asset store supplies the loader.
 */
export interface VisionAdapterOptions extends AdapterOptions {
  /**
   * Resolve one `source` slot `ResolvedAssetRef` (a real `assetId` the
   * runtime's resolution pass produced from `input.references.source`, or
   * one a meta fed straight in) to an image the SDK can send. Called once per
   * source, in `ctx.assets` order; receives the dispatch context as well, for
   * hosts whose store is keyed by session or project.
   */
  loadImage: (
    ref: ResolvedAssetRef,
    ctx: DispatchContext,
  ) => Promise<ImageSource> | ImageSource
}

const SOURCE_SLOT = 'source'

// The mode-default instruction the pattern leaves to "the host adapter". Sent
// as the system text when the caller gave neither `system` nor `prompt`.
const MODE_INSTRUCTION: Readonly<Record<string, string>> = {
  caption: 'Write a one-line caption for the image.',
  describe: 'Describe the image in detail, in several sentences.',
  judge: 'Evaluate the image against the instruction and explain your verdict.',
  'extract-style':
    'Describe the visual style of the image: medium, palette, lighting, composition.',
}

function toFilePart(source: ImageSource): FilePart {
  if (
    source instanceof Uint8Array ||
    source instanceof ArrayBuffer ||
    source instanceof URL
  ) {
    return { type: 'file', mediaType: 'image', data: source }
  }
  return { type: 'file', mediaType: source.mediaType, data: source.data }
}

/**
 * Wrap a vision-capable AI SDK language model as an `image-to-text`
 * `ModelCapability`.
 *
 * Reads every `source` asset off `ctx.assets` (the pattern declares the slot
 * with array cardinality — multi-image comparison is a first-class case) and
 * loads each through `options.loadImage`; every one is sent as a `file` part
 * of the user message, in `ctx.assets` order, ahead of the prompt text. Off
 * the input: `mode`, `system`, `prompt`, `maxLength`, the structured-output
 * pair `responseFormat` / `jsonSchema`, and a flat `providerOptions`, placed
 * as the pattern's own field descriptions say — `system` wins and `mode` is
 * ignored; without one, `prompt` replaces the mode-default text; with
 * neither, the mode default is the system text and the images go up alone.
 * `maxLength` is the soft cap the pattern declares: stated to the model as an
 * instruction in text mode, never cut from the reply, and not applied to JSON
 * output. Returns an `ImageToTextOutput`: `text` (the validated object as
 * JSON when `responseFormat` is `'json'`), `cost: null`.
 */
export function fromVisionModel(
  model: LanguageModelInstance,
  options: VisionAdapterOptions,
): ModelCapability {
  const identity = resolveIdentity(model, options)
  return {
    ...buildRecord(identity, options, {
      capability: 'image-to-text',
      inputs: ['image', 'text'],
      outputs: ['text'],
    }),
    async call<I, O>(input: I, ctx: DispatchContext): Promise<DispatchResult<O>> {
      const fields = asRecord(input)
      const files = (
        await requireSourceAssets<ImageSource>(
          ctx,
          SOURCE_SLOT,
          { name: 'loadImage', load: options.loadImage },
          'image-to-text',
        )
      ).map(toFilePart)
      const mode = optionalString(fields, 'mode') ?? 'caption'
      const modeInstruction = MODE_INSTRUCTION[mode]
      if (modeInstruction === undefined) {
        throw new Error(
          `image-to-text call: input.mode must be one of ${Object.keys(MODE_INSTRUCTION).map((m) => JSON.stringify(m)).join(', ')} (got ${JSON.stringify(mode)})`,
        )
      }
      const system = optionalString(fields, 'system')
      const prompt = optionalString(fields, 'prompt')
      const maxLength = optionalNumber(fields, 'maxLength')
      const structured = readStructuredOutput(fields, 'image-to-text')
      const providerOptions = providerOptionsFor(identity.sdkProviderKey, ctx, fields)

      const systemText =
        system ?? (prompt === undefined ? modeInstruction : undefined)
      const userText = [
        prompt,
        maxLength !== undefined && structured.format === 'text'
          ? `Keep the answer under ${maxLength} characters.`
          : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join('\n\n')

      const startedAt = Date.now()
      const result = await generateText({
        model,
        ...(systemText !== undefined ? { system: systemText } : {}),
        messages: [
          {
            role: 'user',
            content: [
              ...files,
              ...(userText.length > 0
                ? [{ type: 'text' as const, text: userText }]
                : []),
            ],
          },
        ],
        ...(structured.output ? { output: structured.output } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: ctx.signal,
      })

      const output = {
        modality: 'text' as const,
        text:
          structured.format === 'json'
            ? structuredText(result.output)
            : result.text,
        ...dispatchEnvelope(identity, startedAt),
      }
      return { output: output as O }
    },
  }
}
