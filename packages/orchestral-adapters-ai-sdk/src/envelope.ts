// The half of every adapter that is the same across image / speech /
// transcription: who the model is, the record fields the router reads, the
// dispatch envelope the output carries, and the input / providerOptions
// readers. Each `from*` function is then only the capability-specific
// translation between the orchestral dispatch contract and one AI SDK call.

import type { generateImage } from 'ai'
import type {
  Capability,
  DispatchContext,
  Modality,
  ModelCapability,
  ModelTag,
} from '@orchestral/core'
import { MODEL_SPEC_VERSION } from '@orchestral/core'

/**
 * Options shared by every adapter. All optional: the defaults read identity
 * off the AI SDK model instance and declare a plain, untagged envelope.
 */
export interface AdapterOptions {
  /**
   * Override the `provider` stamped on the envelope (and on the output's
   * `provider` / `model` fields). Default: the AI SDK model's `.provider`.
   */
  provider?: string
  /**
   * Override the `modelId` stamped on the envelope. Default: the AI SDK
   * model's `.modelId`. Set it when the host's catalog row is not the SDK's
   * id — a relay slug, a user-facing alias — so `excludeModel` /
   * `pinnedModel` / `rankedModels` match the ids the host actually stores.
   */
  modelId?: string
  /** `ModelTag`s to declare on the envelope (e.g. `['fast']`). Default `[]`. */
  tags?: readonly ModelTag[]
  /** Routing tier, read when a caller passes `ResolveContext.tier`. */
  tier?: 'fast' | 'balanced' | 'premium'
}

/** The fields every AI SDK model object carries, whatever its spec version. */
export interface AiSdkModelLike {
  readonly provider: string
  readonly modelId: string
}

export interface ModelIdentity {
  readonly provider: string
  readonly modelId: string
}

export function resolveIdentity(
  model: AiSdkModelLike,
  options: AdapterOptions,
): ModelIdentity {
  return {
    provider: options.provider ?? model.provider,
    modelId: options.modelId ?? model.modelId,
  }
}

/**
 * The record half of a `ModelCapability` envelope. `specificationVersion` is
 * the imported constant, never a literal: a runtime that cannot execute this
 * adapter generation refuses the envelope before calling into it.
 */
export function buildRecord(
  identity: ModelIdentity,
  options: AdapterOptions,
  shape: {
    capability: Capability
    inputs: readonly Modality[]
    outputs: readonly Modality[]
  },
): Omit<ModelCapability, 'call'> {
  return {
    specificationVersion: MODEL_SPEC_VERSION,
    capabilities: [shape.capability],
    provider: identity.provider,
    modelId: identity.modelId,
    inputs: shape.inputs,
    outputs: shape.outputs,
    tags: options.tags ?? [],
    source: 'user',
    ...(options.tier ? { tier: options.tier } : {}),
  }
}

/**
 * The `dispatchEnvelopeShape` block every first-party atomic output carries.
 * Built in exactly one place so the one fact about cost lives in one place:
 * the AI SDK does not report what a call cost, and `null` is the envelope's
 * word for "not reported" — distinct from `0`, which would claim the call was
 * free.
 */
export function dispatchEnvelope(identity: ModelIdentity, startedAt: number) {
  return {
    cost: null,
    latencyMs: Math.max(0, Date.now() - startedAt),
    model: `${identity.provider}:${identity.modelId}`,
    provider: identity.provider,
  }
}

// ── Input readers ─────────────────────────────────────────────────────────
// `call` receives `unknown`-shaped input (the runtime's caller picks `I`), so
// the adapters read fields defensively and fail with a message naming the
// capability and the field rather than letting the SDK throw on `undefined`.

export type InputRecord = Readonly<Record<string, unknown>>

export function asRecord(input: unknown): InputRecord {
  return input !== null && typeof input === 'object'
    ? (input as InputRecord)
    : {}
}

export function requireString(
  input: InputRecord,
  key: string,
  capability: Capability,
): string {
  const value = input[key]
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error(
    `${capability} call: input.${key} (non-empty string) is required`,
  )
}

export function optionalString(
  input: InputRecord,
  key: string,
): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

export function optionalNumber(
  input: InputRecord,
  key: string,
): number | undefined {
  const value = input[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ── providerOptions ───────────────────────────────────────────────────────

/**
 * The AI SDK's `providerOptions` wire shape: an outer record keyed by provider
 * name, an inner JSON object of provider-specific fields. Pulled off
 * `generateImage`'s own signature (it is the same type on `generateSpeech` and
 * `transcribe`) so the package does not import `@ai-sdk/provider` for one
 * type.
 */
export type SdkProviderOptions = NonNullable<
  Parameters<typeof generateImage>[0]['providerOptions']
>

/**
 * Two sources feed the SDK's `providerOptions`, and they are shaped
 * differently:
 *
 * - `ctx.providerOptions` — host-maintained defaults, validated at the host
 *   boundary. Passed through verbatim; it is expected to already be in the
 *   SDK's wire shape (`{ openai: { quality: 'high' } }`).
 * - `input.providerOptions` — the flat per-model object a first-party
 *   pattern carries on the top level of its input (a meta `compose()` sets it
 *   directly; the derived LLM-facing schema fills it per model). Nested under
 *   the model's provider key here.
 *
 * Per-call wins: an `input.providerOptions` key overrides the same key in
 * `ctx.providerOptions[provider]`. Returns `undefined` when neither is set so
 * the SDK sees no `providerOptions` key at all.
 *
 * Both inputs are `Record<string, unknown>` on the orchestral side and
 * host-validated at the dispatch boundary; the SDK's stricter JSON-object
 * type is the wire contract, so the cast happens here, at one trusted seam.
 */
export function providerOptionsFor(
  provider: string,
  ctx: DispatchContext,
  input: InputRecord,
): SdkProviderOptions | undefined {
  const base = ctx.providerOptions as SdkProviderOptions | undefined
  const flat = input.providerOptions
  const perCall =
    flat !== null && typeof flat === 'object' && !Array.isArray(flat)
      ? (flat as SdkProviderOptions[string])
      : undefined
  if (!perCall) return base
  return {
    ...base,
    [provider]: { ...base?.[provider], ...perCall },
  }
}
