// @orchestral/core
// Pattern + ModelCapability + Alternative three-layer model;
// Pattern : Capability = 1:1; primary path + declarative Alternative fallbacks;
// LLM-facing fields collected under `tool` sub-object.
//
// This entry is contracts and pure functions. The two batteries that used to
// sit here answer from their own entries instead:
//
//   @orchestral/core/memory   InMemoryJobStore / InMemoryAssetStore /
//                             InMemoryTranscriptStore — dev-and-test stores
//   @orchestral/core/routing  createDefaultCapabilityRouter — one answer to
//                             the CapabilityRouter interface below
//
// Neither is re-exported here. A deprecated alias would leave both spellings
// resolvable and put "core is the vocabulary" back into prose, where it spent
// its whole life being unfalsifiable.

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
export type { NamespaceId, SubagentBlocklist } from './catalog'
export {
  DEFAULT_SUBAGENT_BLOCKLIST,
  inferNamespace,
  matchSubagentBlocklist,
  resolveNamespace,
} from './catalog'

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

// ── Router tool input contracts ──────────────────────────────────────────
// The two fixed router tools' wire schemas. `buildCatalogDescriptors`
// serialises them into the tool definitions and a host validates incoming
// tool calls against them. The retrieval that answers a validated
// `find_pattern` call (BM25 index + `handleFindPattern`) is not a contract and
// ships separately in `@orchestral/discovery`.
// DESIGN: find-pattern-schema-stays-in-core
export {
  FindPatternInputSchema,
  type FindPatternInput,
} from './find-pattern-schema'
// Who answers a validated find_pattern call. A contract only: the first-party
// BM25 implementation ships in @orchestral/discovery (`createPatternSearch`),
// and a host that replaces retrieval implements this instead. @orchestral/
// runtime takes one as `InlineRuntimeInit.patternSearch`.
export type {
  PatternSearch,
  PatternSearchRequest,
} from './pattern-search'
// One resolver for every by-id dispatch, LLM-facing or person-facing. The
// `audience` argument picks the exposure flag it gates on; a slash command's
// unqualified short name is a spelling of the id, not a surface, so it resolves
// on the same path. There is no second entry point and no second error
// vocabulary — which refusal a user saw used to depend on which one the host
// happened to call.
export {
  resolveDispatchTarget,
  isDispatchError,
  DispatchPatternInputSchema,
  type DispatchAudience,
  type DispatchPatternInput,
  type DispatchPatternError,
  type ResolveDispatchOptions,
  type ResolvedDispatchTarget,
} from './dispatch-pattern'

// ── Plan ─────────────────────────────────────────────────────────────────
// A plan — a meta whose compose is a list of `$`-referencing steps — is one
// Pattern's wire format, not this library's vocabulary, so the whole feature
// (schema, `validatePlan`, the interpreter, the preflight) is
// `@orchestral/plan`. The primitive all four share, "read a `$ref` off a step's
// input", used to be copied once per package; it is one function there now:
//
//   import { PlanDagSchema, validatePlan } from '@orchestral/plan'

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
// DESIGN: to-json-schema-boundary-export
export { toJsonSchema } from './schema'

// ── Bounded output-field vocabulary (sanitizer companion) ────────────────
// Every string field in a Pattern / host-tool outputs schema carries an
// explicit upper bound so unbounded binary blobs are unrepresentable at the
// source. `auditOutputsSchema` is a pure checker; PatternRegistry.register
// runs it as a non-fatal warn on every registered pattern's outputs schema
// (OUTPUTS_UNBOUNDED_FIELDS). Host-injected tool schemas are outside the
// registry, so a host that wants the same guarantee calls the checker itself.
//
// `ASSET_KINDS` is deliberately NOT here. `AssetKind` is the declaration and
// `assetKindField()` is how a schema states it; the tuple is the runtime twin
// the enum is built from, and a consumer that wants the members reads
// `assetKindField().options` — one export, no second list to keep in step.
// Same call as `FIRST_PARTY_CAPABILITIES` in capability.ts, which stays off the
// barrel for the same reason.
export {
  assetIdField,
  assetKindField,
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
  sumCosts,
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
// Adapter-contract generation marker. `MODEL_SPEC_VERSION` is what a new
// `ModelCapability` declares as its `specificationVersion`;
// `assertSupportedModelSpecVersion` is the guard the dispatch path runs before
// `call`, so an adapter built for a generation this build cannot execute fails
// with a stable `MODEL_SPEC_VERSION_UNSUPPORTED` code instead of being called.
export {
  assertSupportedModelSpecVersion,
  MODEL_SPEC_VERSION,
  ModelSpecVersionUnsupportedError,
  SUPPORTED_MODEL_SPEC_VERSIONS,
  type ModelSpecVersion,
} from './model-spec-version'
export type {
  CapabilityRouter,
  SatisfiableResult,
} from './capability-router'
// The default (storage-agnostic) implementation of that interface, and the two
// errors it throws, ship one level down:
//
//   import { createDefaultCapabilityRouter } from '@orchestral/core/routing'
//
// The interface is vocabulary; the (capability, tags, ctx) → model algorithm
// behind it — the largest body of policy in this package — is one answer to it.
// Keeping both on this barrel made "core is the vocabulary" a sentence no
// import list could contradict.
// Routing visibility: the structured dump `CapabilityRouter.explain` returns
// (which model was dropped by which filter, the surviving order, what resolve
// would do) plus a printable rendering of it. `explain` is optional on the
// interface — feature-detect before calling.
export {
  formatRoutingExplanation,
  type RoutingCandidate,
  type RoutingDropStage,
  type RoutingExplanation,
  type RoutingOutcome,
  type RoutingSelectionRule,
} from './routing-explanation'
export { deriveCapabilities } from './derive-caps'
// Pure derive function (the host invokes it via the deriveProviderOptionsZod
// closure passed into `handleFindPattern` in @orchestral/discovery).
//
// `deriveLlmFacingInputSchema` lifts the host-marked fields and replaces
// input.providerOptions with typed z.object(remaining). `LIFT_MARKER` is the
// symbol the host stamps onto the fields it wants lifted — the derive function
// reads only the marker's presence, never its payload.
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
  whenAlways,
} from './alternative-builders'
// Whether a declared path APPLIES is contract (a read of `appliesWhen` against
// the registry and the router); whether an applying path is TAKEN is runtime
// policy. Both @orchestral/runtime's ALTERNATIVES_NOT_ENABLED diagnostic and
// @orchestral/plan's preflight report the paths not taken, and they read the
// same evaluation from here rather than each other's copy.
export {
  applicableAlternatives,
  pickAlternative,
  readRequiresSemantics,
  toAvailableAlternative,
  type AlternativeSelectionDeps,
  type AvailableAlternative,
} from './alternative-select'

// ── Registry ─────────────────────────────────────────────────────────────
export { PatternRegistry } from './registry'
export type {
  AddFromManifestOptions,
  AddFromManifestResult,
  PatternScope,
  RegistryEntry,
  SkippedManifestPattern,
} from './registry'
// Pattern-package convention: the package.json `"orchestral"` field a package
// publishes so its patterns are discoverable without executing it, and the
// errors `PatternRegistry.addFromManifest` throws when the declaration and the
// module disagree.
export {
  ManifestError,
  OrchestralManifestPatternSchema,
  OrchestralManifestSchema,
  type ManifestErrorCode,
  type OrchestralManifest,
  type OrchestralManifestPattern,
} from './manifest'

// ── Runtime contract ─────────────────────────────────────────────────────
// (Implementations live in @orchestral/runtime; this package ships only the
// substrate-agnostic interface.)
export type {
  AgentToolRejection,
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
// The contract only. The dev-and-test implementation is `InMemoryJobStore`
// from `@orchestral/core/memory`; production hosts owe the Runtime a durable
// one, and this barrel is what they write against.
export type {
  JobStore,
  JobQueryFilter,
  Unsubscribe,
} from './job-store'
// The job state machine, and the reason it sits on the contracts entry rather
// than next to the store that consumes it: every durable host JobStore has to
// judge its writes with it. The legality table and the transition -> event map
// live here and nowhere else, so a host is not re-deriving either half from a
// dev-only implementation's private switch.
export { JOB_TERMINAL_STATUSES, nextJobState } from './job-state'
export type { JobLifecycleEventType, JobTransition } from './job-state'
export type { Runtime, ResolveCtxProvider } from './runtime'
export type {
  DispatchContext,
  SystemPromptContext,
  ExecutionContext,
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
export type {
  TranscriptMessage,
  TranscriptMessageWithAgent,
  TranscriptStore,
} from './transcript-store'
export type { AgentDispatchEnvelope } from './agent-envelope'
export type {
  DispatchMiddleware,
  DispatchDecision,
} from './middleware'

// ── Diagnostics ──────────────────────────────────────────────────────────
// Everything that happens to a job is a JobEvent. What has no job to report
// on — a host callback that threw, a registration-time authoring lint — goes
// through this seam instead of straight to the console, so the host decides
// where it lands. `PatternRegistry` and `InlineRuntimeInit` both take one;
// both default to `consoleDiagnosticsLogger`.
export {
  consoleDiagnosticsLogger,
  silentDiagnosticsLogger,
  type DiagnosticsLogger,
} from './logger'

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
export type {
  AssetStore,
  RecordAssetInput,
  AssetRecord,
  ListContextFilter,
} from './asset-store'
