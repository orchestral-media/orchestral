// @orchestral/core
// Pattern + ModelCapability + Alternative three-layer model;
// Pattern : Capability = 1:1; primary path + declarative Alternative fallbacks;
// LLM-facing fields collected under `tool` sub-object.

// ── Core vocabulary ──────────────────────────────────────────────────────
export type { Capability } from './capability'
export type { ModelTag } from './model-tag'
export type {
  PatternId,
  AtomicPatternId,
  MetaPatternId,
  AgentPatternId,
  ZodSchema,
} from './foundational'

// ── Catalog namespace ────────────────────────────────────────────────────
export type { NamespaceId } from './catalog'
export { DEFAULT_SUBAGENT_BLOCKLIST, inferNamespace, resolveNamespace } from './catalog'

// ── Pattern ──────────────────────────────────────────────────────────────
// Capability branches are expressed by mounting assets via input.references
// plus the provider's self-reported typed providerOptions schema.
export type {
  Pattern,
  PatternBase,
  AtomicPattern,
  MetaPattern,
  AgentPattern,
  PrimaryPath,
  DispatchResult,
  Artifact,
  StopConditionDescriptor,
  PatternExposure,
  // Public `Pattern.exposureMode` / `PatternBase.exposureMode` field type —
  // exported so consumers can name the catalog-load strategy literal.
  PatternExposureMode,
  // Per-surface exposure
  PatternExposureShorthand,
  PatternExposureMap,
  ResolvedExposure,
  ToolDescriptor,
  PermissionResult,
  AgentFinishSpec,
  AgentRunFacts,
} from './pattern'
export { resolveExposure } from './pattern'
export {
  defineAtomicPattern,
  type AtomicPatternInit,
} from './atomic-pattern'
export type { PatternRef } from './pattern-ref'

// ── Agent finish contract ────────────────────────────────────────────────
// Default trio (inputs + outputs + compose) the registry backfills when an
// agent declares no finish mechanism, plus the finish tool descriptor builder.
export {
  AGENT_FINISH_TOOL_NAME,
  defaultAgentFinishInputs,
  defaultAgentFinishOutputs,
  defaultAgentFinishCompose,
  DEFAULT_AGENT_FINISH_SPEC,
  buildFinishDescriptor,
  type DefaultAgentFinishInput,
  type DefaultAgentFinishOutput,
} from './agent-finish'

// ── Catalog rendering ────────────────────────────────────────────────────
// Collapses the per-Pattern tool catalog into two fixed router tools
// (find_pattern + dispatch_pattern) the LLM uses to discover and invoke
// Patterns, instead of one tool definition per Pattern.
export {
  buildAlwaysLoadDescriptors,
  buildCatalogDescriptors,
  type AgentToolDescriptor,
  type BuildCatalogDescriptorsOptions,
} from './catalog-builder'
export {
  PatternSearchIndex,
  type PatternSearchFilter,
  // Element type of the public `PatternSearchIndex.skipped` getter — exported
  // so callers (typically find_pattern) can name what they iterate over.
  type SkippedPatternRecord,
} from './pattern-search-index'
export {
  handleFindPattern,
  FindPatternInputSchema,
  type FindPatternInput,
  type FindPatternResult,
  type FindPatternMatch,
  type FindPatternOutputsSummary,
  type HandleFindPatternOptions,
} from './find-pattern'
export {
  resolveDispatchTarget,
  isDispatchError,
  DispatchPatternInputSchema,
  type DispatchAudience,
  type DispatchPatternInput,
  type DispatchPatternError,
  type ResolvedDispatchTarget,
} from './dispatch-pattern'
export {
  resolveSlashDispatch,
  type SlashDispatchError,
  type SlashDispatchResolution,
} from './slash-dispatch'

// ── Tool-output sanitizer (defense-in-depth) ─────────────────────────────
export { sanitizeToolOutput } from './sanitize'
export type {
  OnStrip,
  SanitizeToolOutputOptions,
  StripReason,
} from './sanitize'

// ── Schema outbound serialization (zod → JSON Schema) ────────────────────
// Patterns are authored in zod and stay zod internally. `toJsonSchema(zodSchema)`
// is the only boundary helper — call it explicitly when serializing outbound to
// the LLM / IPC wire format. Raw JsonSchema authoring is intentionally not
// supported (YAGNI; ensureZod + a dependency can be added later if needed).
export { toJsonSchema } from './schema'

// ── Bounded output-field vocabulary (sanitizer companion) ────────────────
// Every string field in a Pattern / host-tool outputs schema carries an
// explicit upper bound so unbounded binary blobs are unrepresentable at the
// source. `auditOutputsSchema` is a pure checker; PatternRegistry.register
// runs it as a non-fatal warn on every registered pattern's outputs schema
// (OUTPUTS_UNBOUNDED_FIELDS). The 7 host-tool schemas are not yet retrofitted
// (separate follow-up).
export {
  assetIdField,
  auditOutputsSchema,
  boundedText,
  opaqueToken,
  urlField,
} from './output-fields'
export type { OutputsSchemaAudit } from './output-fields'

// ── Dispatch output envelope ─────────────────────────────────────────────
// Composable raw zod shapes (spread into z.object) unifying the cost /
// latencyMs / model / provider block atomics share, the produced-asset element,
// and the cost + latencyMs metas must aggregate.
export {
  dispatchEnvelopeShape,
  metaEnvelopeShape,
  producedAssetShape,
  type ProducedAssetModality,
} from './output-envelope'


// ── Capability routing ───────────────────────────────────────────────────
export type {
  Modality,
  ModelCapability,
  ModelCapabilityRecord,
  ModelCapabilityBlob,
  ResolveContext,
  CapabilitySource,
  CallEvents,
  JsonSchema,
} from './capability-model'
export type {
  CapabilityRouter,
  SatisfiableResult,
} from './capability-router'
// Default (storage-agnostic) router algorithm + the errors it throws. A host
// injects `getModels` (wrapped envelopes) + `getCapabilityOrder` (enablement
// gate) and reduces to a thin adapter; the (capability, tags, ctx) → model
// selection lives here.
export {
  createDefaultCapabilityRouter,
  NoModelForCapabilityError,
  ModelExcludedError,
  type DefaultCapabilityRouterDeps,
} from './capability-router-default'
export { deriveCapabilities } from './derive-caps'
// Pure derive function (the host invokes it via the deriveProviderOptionsZod
// closure passed into handleFindPattern).
//
// `deriveLlmFacingInputSchema` lifts the host-marked fields and replaces
// input.providerOptions with typed z.object(remaining). `LIFT_MARKER` is the
// symbol the host stamps onto the fields it wants lifted — OSS reads only it.
export {
  deriveLlmFacingInputSchema,
  LIFT_MARKER,
  ASSET_MARKER,
} from './derive-pattern-input'
// Raw references derivation — @alpha test seam; production code goes
// through extendInputsWithReferences (semantics on its JSDoc).
export { deriveReferencesSchema } from './derive-references-schema'
export { extendInputsWithReferences } from './extend-inputs-with-references'

// ── Alternatives (cross-Pattern fallback) ────────────────────────────────
export type {
  Alternative,
  AlternativeAppliesWhen,
  Semantics,
  UnavailabilityReason,
} from './alternative'
export {
  whenCapabilityUnavailable,
  whenPreservesRequired,
  whenBudgetBelow,
  whenAlways,
} from './alternative-builders'

// ── Registry ─────────────────────────────────────────────────────────────
export { PatternRegistry } from './registry'
export type { RegistryEntry } from './registry'

// ── Runtime contract ─────────────────────────────────────────────────────
// (Implementations live in @orchestral/runtime; this package ships only the
// substrate-agnostic interface.)
export type {
  Job,
  JobSpec,
  JobEvent,
  JobStatus,
  JobError,
  JobKind,
} from './job'
// ── Human-in-the-loop pause ──────────────────────────────────────────────
export type { AskUserRequest, AskUserKind } from './pause'
export { buildAskUserFacade } from './ask-user'
// The per-kind payload / answer schemas are the normative ask-user protocol —
// a host parses what it receives and validates what it returns against these.
export {
  AskUserChoiceAnswerSchema,
  AskUserChoicePayloadSchema,
  AskUserConfirmAnswerSchema,
  AskUserConfirmPayloadSchema,
  AskUserFieldValueSchema,
  AskUserFormAnswerSchema,
  AskUserFormFieldSchema,
  AskUserFormPayloadSchema,
} from './ask-user'
export type {
  AskUser,
  AskUserGeneric,
  AskUserFormField,
  AskUserFieldValue,
  AskUserChoiceAnswer,
  AskUserChoicePayload,
  AskUserConfirmAnswer,
  AskUserConfirmPayload,
  AskUserFormAnswer,
  AskUserFormPayload,
} from './ask-user'
export type {
  JobStore,
  JobQueryFilter,
  Unsubscribe,
} from './job-store'
export { InMemoryJobStore } from './job-store-memory'
export type { Runtime } from './runtime'
export type {
  DispatchContext,
  SystemPromptContext,
  ExecutionContext,
  BudgetGuard,
  Tracer,
  Span,
  // Step / compute primitives
  RetryPolicy,
  StepOptions,
  StepMeta,
  StepResult,
  CtxStepFn,
  CtxComputeFn,
  AskUserOptions,
  AskUserHandler,
} from './execution-context'
export { parallel, type ParallelFn } from './parallel'
export {
  createPatternFn,
  type PatternFn,
  type PatternFnOptions,
} from './create-pattern-fn'
export {
  AGENT_BASE_INPUT_SCHEMA,
  agentInputSchema,
  type AgentBaseInput,
} from './agent-input-schema'
export {
  InMemoryTranscriptStore,
  type TranscriptMessage,
  type TranscriptMessageWithAgent,
  type TranscriptStore,
} from './transcript-store'
export type { AgentDispatchEnvelope } from './agent-envelope'
export type {
  DispatchMiddleware,
  DispatchDecision,
} from './middleware'

// ── AssetLedger primitives ───────────────────────────────────────────────
export {
  mintHandle,
  buildAssetIndex,
  resolveAssetReferences,
  projectAssetsForModel,
  projectToolOutputForModel,
  type ModelFacingOutputAsset,
} from './asset-index'
export {
  toAssetUri,
  isAssetUri,
  fromAssetUri,
  setAssetUriScheme,
} from './asset-uri'
export type {
  Handle,
  AssetKind,
  AssetAnnouncement,
  AssetLedgerEntry,
  AssetEvent,
  AssetReferences,
  DerivedReferences,
  AssetNeed,
  ResolvedAssetRef,
  HandleSnapshot,
  ModelFacingAsset,
  AssetResolutionError,
  QuerySpec,
  AssetIndex,
} from './asset-index.types'
export {
  InMemoryAssetStore,
} from './asset-store'
export type {
  AssetStore,
  RecordAssetInput,
  AssetRecord,
  ListContextFilter,
} from './asset-store'
