// The half of every adapter that is the same across image / speech /
// transcription / language / vision: who the model is, the record fields the
// router reads, the dispatch envelope the output carries, the input /
// providerOptions readers, and the id each produced file goes out under. Each
// `from*` function is then only the capability-specific translation between
// the orchestral dispatch contract and one AI SDK call.

import type { generateImage } from 'ai'
import type {
  Artifact,
  CallEvents,
  Capability,
  DispatchContext,
  Modality,
  ModelCapability,
  ModelTag,
  ResolvedAssetRef,
} from '@orchestral/core'
import { assetIdField, MODEL_SPEC_VERSION } from '@orchestral/core'

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
  /**
   * The key `providerOptions` is nested under on the wire. Default: the first
   * `.`-separated segment of the AI SDK model's own `.provider`
   * (`openai.image` → `openai`).
   *
   * Deliberately not `provider`: that one is the catalog's routing identity,
   * and the host above is invited to overwrite it with a relay slug or an
   * alias so `excludeModel` / `pinnedModel` match. Nesting per-call options
   * under a slug no provider answers to is how they get dropped — the SDK
   * hands each provider the key that names it and says nothing about the
   * rest, so a wrong key is silence, not an error. Set this when the
   * first-segment rule is wrong for the provider you registered.
   */
  sdkProviderKey?: string
  /** `ModelTag`s to declare on the envelope (e.g. `['fast']`). Default `[]`. */
  tags?: readonly ModelTag[]
  /** Routing tier, read when a caller passes `ResolveContext.tier`. */
  tier?: 'fast' | 'balanced' | 'premium'
  /**
   * Mint the `assetId` each produced file is returned under. `fromImageModel`
   * and `fromSpeechModel` call it once per produced artifact, in output
   * order, with the artifact (the bytes as a `data:` URI, plus `mime`), its
   * index in the output's `assets[]`, and the dispatch context; the string
   * returned is that element's `assetId`.
   *
   * This is where a host that stores the bytes mints the id it stores them
   * under, so the output carries the id the host will look up — the same
   * posture as `loadAudio` / `loadImage`, on the producing side. An
   * orchestral `assetId` is whatever the host's store says it is;
   * `@orchestral/core` defines no assetId → bytes write any more than it
   * defines the read, and the adapter never sees the store. Minting the id
   * here, at the moment the output is produced, is what lets the next step
   * in a meta resolve it: an id rewritten after the fact is one the runtime
   * has already handed on.
   *
   * The minted id is stamped on the artifact's `meta.assetId` before
   * `events.onArtifact` fires, so the `job:artifact` event and the output
   * element agree. Must be a non-empty string of at most 128 characters
   * (`assetIdField()`'s bound); anything else fails the call with
   * `MINT_ASSET_ID_INVALID` before any artifact event fires.
   *
   * Default: a positional placeholder (`aisdk-image-<i>`, `aisdk-audio-0`)
   * that names nothing in any store.
   */
  mintAssetId?: (artifact: Artifact, index: number, ctx: DispatchContext) => string
}

/** The fields every AI SDK model object carries, whatever its spec version. */
export interface AiSdkModelLike {
  readonly provider: string
  readonly modelId: string
}

export interface ModelIdentity {
  readonly provider: string
  readonly modelId: string
  /**
   * Kept apart from `provider` because the two answer different questions:
   * `provider` is the row a host's catalog routes on, this is the name the
   * AI SDK's provider matches `providerOptions` against.
   */
  readonly sdkProviderKey: string
}

export function resolveIdentity(
  model: AiSdkModelLike,
  options: AdapterOptions,
): ModelIdentity {
  return {
    provider: options.provider ?? model.provider,
    modelId: options.modelId ?? model.modelId,
    sdkProviderKey:
      options.sdkProviderKey ?? model.provider.split('.')[0] ?? model.provider,
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

// ── Produced assets ───────────────────────────────────────────────────────

/**
 * One produced file: the artifact as it goes out (its `meta.assetId` already
 * stamped), and the id its `assets[]` element carries.
 */
export interface MintedArtifact {
  readonly assetId: string
  readonly artifact: Artifact
}

// `assetIdField()`'s bound, plus non-empty: an empty id names nothing.
const ASSET_ID = assetIdField().min(1)

/**
 * Give every produced artifact the `assetId` its `assets[]` element will
 * carry, and fire `events.onArtifact` for each. The id is
 * `options.mintAssetId`'s answer when the host gave one, else `placeholder`.
 *
 * The order is fixed here rather than in each adapter: every id is minted and
 * checked first, then stamped on its artifact's `meta.assetId`, and only then
 * do the artifact events fire. So the event a host sees carries the id the
 * output will carry, and an invalid id fails the call before any event has
 * announced a file the output will never name.
 */
export function mintAssetIds(
  produced: readonly Artifact[],
  ctx: DispatchContext,
  events: CallEvents | undefined,
  options: AdapterOptions,
  capability: Capability,
  placeholder: (index: number) => string,
): readonly MintedArtifact[] {
  const minted = produced.map((artifact, index): MintedArtifact => {
    const assetId = options.mintAssetId
      ? options.mintAssetId(artifact, index, ctx)
      : placeholder(index)
    if (!ASSET_ID.safeParse(assetId).success) {
      throw Object.assign(
        new Error(
          `MINT_ASSET_ID_INVALID: ${capability} call: mintAssetId returned ${describeId(assetId)} for artifact ${index}; an assetId is a non-empty string of at most 128 characters`,
        ),
        { code: 'MINT_ASSET_ID_INVALID' },
      )
    }
    return {
      assetId,
      artifact: { ...artifact, meta: { ...artifact.meta, assetId } },
    }
  })
  for (const { artifact } of minted) events?.onArtifact?.(artifact)
  return minted
}

// The hook is typed to return a string; a JS host that forgot a `return` is
// the case the runtime check exists for, so the message says what arrived.
function describeId(id: unknown): string {
  if (id === undefined || id === null) return String(id)
  if (typeof id !== 'string') return `a ${typeof id}`
  if (id.length === 0) return 'an empty string'
  return `a ${id.length}-character string`
}

// ── Unmapped asset slots ──────────────────────────────────────────────────

/**
 * Refuse a dispatch whose resolved assets include a slot this adapter does not
 * send to the provider.
 *
 * `text-to-image`'s `reference` / `control` and `text-to-speech`'s
 * `voiceClone` change what the output MEANS — a caller who attached a
 * reference face asked for that face, not for a plausible portrait. Dropping
 * them silently is the one failure a host cannot see in the output it gets
 * back. The generic mapping is still a guess (`generateImage`'s editing input
 * and the voice-cloning APIs are provider-specific), so the adapter refuses
 * instead of inventing one, and names the slot so the host knows exactly what
 * its own adapter has to carry.
 */
export function refuseUnmappedAssetSlots(
  ctx: DispatchContext,
  capability: Capability,
  mapped: readonly string[],
): void {
  const unmapped = [
    ...new Set(
      (ctx.assets ?? [])
        .filter((ref) => !mapped.includes(ref.slot))
        .map((ref) => ref.slot),
    ),
  ]
  if (unmapped.length === 0) return
  const slots = unmapped.map((slot) => JSON.stringify(slot)).join(', ')
  throw Object.assign(
    new Error(
      `ASSET_SLOT_NOT_SUPPORTED: ${capability} call: this adapter does not send the resolved asset slot(s) ${slots} to the provider — write an adapter that does, wrap this one and add them, or drop the reference from the input to call this model without them`,
    ),
    { code: 'ASSET_SLOT_NOT_SUPPORTED' },
  )
}

// ── Source assets ─────────────────────────────────────────────────────────

/**
 * The host hook that turns one resolved asset into bytes, plus the
 * `AdapterOptions` field it arrived on. The name is carried so the failure
 * message says `loadImage` / `loadAudio` — the thing the host actually wrote
 * — rather than a generic "the loader".
 */
export interface SourceLoader<T> {
  readonly name: string
  readonly load: (ref: ResolvedAssetRef, ctx: DispatchContext) => Promise<T> | T
}

// One failure, one shape, one place. Left to each adapter, the same missing
// source came out two ways: vision's carried a `.code` a host can branch on,
// transcription's was a bare Error that reached the host as the generic
// DISPATCH_EXECUTE_FAILED. Code attached rather than only prefixed because
// `normaliseError` lifts `.code` onto `JobError.code`; the prefix is for the
// human reading the message.
function sourceRefs(
  ctx: DispatchContext,
  slot: string,
  capability: Capability,
): readonly ResolvedAssetRef[] {
  const refs = (ctx.assets ?? []).filter((ref) => ref.slot === slot)
  if (refs.length === 0) {
    throw Object.assign(
      new Error(
        `NO_SOURCE_ASSET: ${capability} call: no resolved asset in slot "${slot}" on ctx.assets — the runtime fills it from input.references.${slot}`,
      ),
      { code: 'NO_SOURCE_ASSET' },
    )
  }
  return refs
}

async function loadSource<T>(
  ref: ResolvedAssetRef,
  ctx: DispatchContext,
  slot: string,
  loader: SourceLoader<T>,
  capability: Capability,
): Promise<T> {
  const loaded = await loader.load(ref, ctx)
  if (loaded == null) {
    throw Object.assign(
      new Error(
        `SOURCE_ASSET_NOT_LOADED: ${capability} call: ${loader.name} returned nothing for asset "${ref.assetId}" in slot "${slot}"`,
      ),
      { code: 'SOURCE_ASSET_NOT_LOADED' },
    )
  }
  return loaded
}

/**
 * The single-cardinality read: the first resolved ref in `slot`, through the
 * host's loader. Fails with `NO_SOURCE_ASSET` when the slot resolved to
 * nothing, and with `SOURCE_ASSET_NOT_LOADED` when the loader answered
 * nothing — both before the provider is called.
 */
export async function requireSourceAsset<T>(
  ctx: DispatchContext,
  slot: string,
  loader: SourceLoader<T>,
  capability: Capability,
): Promise<T> {
  const [ref] = sourceRefs(ctx, slot, capability)
  return loadSource(ref as ResolvedAssetRef, ctx, slot, loader, capability)
}

/**
 * The array-cardinality read: every resolved ref in `slot`, in `ctx.assets`
 * order (multi-image comparison is a first-class case), same two failures.
 */
export async function requireSourceAssets<T>(
  ctx: DispatchContext,
  slot: string,
  loader: SourceLoader<T>,
  capability: Capability,
): Promise<readonly T[]> {
  return Promise.all(
    sourceRefs(ctx, slot, capability).map((ref) =>
      loadSource(ref, ctx, slot, loader, capability),
    ),
  )
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

/** An array of strings, or `undefined` when the field is absent or not one. */
export function optionalStringArray(
  input: InputRecord,
  key: string,
): string[] | undefined {
  const value = input[key]
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined
}

// ── providerOptions ───────────────────────────────────────────────────────

/**
 * The AI SDK's `providerOptions` wire shape: an outer record keyed by provider
 * name, an inner JSON object of provider-specific fields. Pulled off
 * `generateImage`'s own signature (it is the same type on `generateSpeech`,
 * `transcribe` and `generateText`) so the package does not import
 * `@ai-sdk/provider` for one type.
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
 *   directly; the derived LLM-facing schema fills it per model). Nested here
 *   under the model's SDK provider key (`ModelIdentity.sdkProviderKey`) —
 *   never under the routing `provider`, which the host may have replaced
 *   with a slug the SDK has never heard of.
 *
 * Per-call wins: an `input.providerOptions` key overrides the same key in
 * `ctx.providerOptions[sdkProviderKey]`. Returns `undefined` when neither is
 * set so the SDK sees no `providerOptions` key at all.
 *
 * Both inputs are `Record<string, unknown>` on the orchestral side and
 * host-validated at the dispatch boundary; the SDK's stricter JSON-object
 * type is the wire contract, so the cast happens here, at one trusted seam.
 */
export function providerOptionsFor(
  sdkProviderKey: string,
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
    [sdkProviderKey]: { ...base?.[sdkProviderKey], ...perCall },
  }
}
