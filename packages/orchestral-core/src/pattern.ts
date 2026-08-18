// Core Pattern DSL — Pattern.kind = 'agent' is the third state.
//
// The Pattern model closes over three states along the plan-source axis:
//   • atomic — a single capability, no plan (runtime resolves one model.call)
//   • meta   — plan produced outside the runtime (host code / user UI / tutorial)
//   • agent  — plan decided dynamically by the runtime's inner LLM inside a loop
//
// The shared caller-view (id/description/primary?/outputs) is extracted into
// PatternBase; kind-specific fields (compose / loop) live on each narrow
// interface.
//
// Asset references: the LLM fills a handle in `inputs.references`, and the OSS
// resolution pass resolves + validates it via AssetIndex into `ctx.assets`;
// host-injected context (projectId / providerOptions) flows through
// `ExecutionContext`. `bindings` has been fully removed.
//
// ── Important conventions ───────────────────────────────────────────────────
//
// 1. **Patterns do not declare a `providerOptions` placeholder field** (no
//    `z.record(z.unknown()).optional()` boilerplate). At runtime,
//    `derive-pattern-input.ts deriveLlmFacingInputSchema` injects
//    `providerOptions: z.object(remaining)` from the typed providerOptions
//    schema self-reported by the router's top-1 model, and lifts host-marked
//    (LIFT_MARKER) fields up to the input top level. With no curated schema,
//    deriveLlmFacingInputSchema returns the baseSchema unchanged, so the LLM
//    never sees a useless placeholder.
//
// 2. **Capability branches live in the input, not on the Pattern.** The
//    branches of an atomic Pattern (ip-adapter / controlnet / inpaint /
//    outpaint / style-transfer / lora-style / end-frame-conditioning /
//    native-audio / voice-clone) are absorbed into:
//    - `input.references.{slot}` asset mounts (reference / control / mask /
//      endFrame / voice) — the LLM fills a handle, the host resolution pass
//      resolves it into ctx.assets
//    - the provider's self-reported typed `providerOptions` schema — the LLM
//      sees the derived schema and fills provider-specific raw fields directly
//      (`ip_adapter_image_url` / `loras` / etc.)
//    - hard model constraints expressed via `z.literal(value)` in the provider
//      providerOptions schema
// ──────────────────────────────────────────────────────────────────────────

import type { AssetNeed, ResolvedAssetRef } from './asset-index.types'
import type { PatternId, ZodSchema } from './foundational'
import type { ModelTag } from './model-tag'
import type { NamespaceId } from './catalog'
import type {
  DispatchContext,
  ExecutionContext,
  SystemPromptContext,
} from './execution-context'

/**
 * Shared caller-view shape. The fields the LLM (or host submitJob) sees are
 * fully symmetric across kinds — kind-specific fields (compose/loop) go on
 * each narrow interface, not on the base.
 */
export interface PatternBase<I = unknown, O = unknown> {
  id: PatternId
  /**
   * Summary for host engineers. The tool description the LLM sees lives on
   * `primary.tool` / Meta `tool`, not here.
   */
  description: string
  /**
   * LLM-facing surface (optional). Present = enters the LLM catalog and can be
   * triggered by a tool call (99% of cases); absent = invisible to the LLM,
   * host-triggerable only (rare, e.g. scheduled tasks).
   *
   * Required on the Atomic narrow (no primary means it can't dispatch); Meta
   * doesn't use primary (tool is top-level), so it isn't narrowed; Agent keeps
   * the base optional.
   */
  primary?: PrimaryPath<I>
  /** Public outputs schema — shared by primary + alternatives. */
  outputs: ZodSchema<O>
  /**
   * High-signal BM25 retrieval field — `find_pattern` uses it as the primary
   * match signal for tool-selection (same boost tier as patternId tokens). A
   * short, natural 3-10 word English phrase, verb-first, describing the
   * capability itself.
   *
   * Avoid repeating tokens patternId already contains — `patternIdParts`
   * already indexes those. The runtime's `find_pattern.query` describe text
   * already asks the LLM to translate non-English requests into English
   * keywords before calling, so write English only here (see find-pattern.ts
   * FindPatternInputSchema.query).
   *
   * Examples:
   *   • image-to-text → 'describe an image or extract text via OCR'
   *   • text-to-image → 'generate an image from a text prompt'
   *   • text-to-speech → 'synthesize speech audio from text (TTS)'
   *
   * Optional; when omitted, BM25 relies mainly on `primary.tool.description`
   * (which feeds toolDescriptions) + patternId tokens. Strongly recommended
   * for every first-party Pattern — it's the author's most direct
   * retrieval-tuning lever and a high-IDF signal source when the LLM walks the
   * catalog.
   */
  searchHint?: string
  /**
   * Catalog visibility declaration (default `'tool'`). Orthogonal to
   * AgentPattern.loop.toolPatternIds, which is an explicit whitelist —
   * exposure is a negative filter (hide from some audiences), toolPatternIds
   * is a positive whitelist (expose only these). Together they address LLM
   * tool-selection interference:
   *
   * - `'tool'` (default): visible to both audiences — chat-turn catalog +
   *   AgentPattern loop catalog. 99% of cases, domain capabilities
   *   (text-to-image / etc.).
   * - `'agent-tool'`: visible only in the AgentPattern loop catalog, hidden
   *   from the chat-turn catalog. For fine-grained primitives
   *   (video-to-frames / etc.): they're building blocks for subagent compose,
   *   and exposing them directly to chat-turn only adds to the LLM's selection
   *   burden.
   * - `'no-tool'`: invisible to every LLM catalog — host-direct
   *   `runtime.submitJob` only. For internal dispatch tools (scheduled tasks /
   *   data migration / etc.).
   *
   * When to explicitly mark `'agent-tool'` / `'no-tool'`: when the Pattern
   * author finds the LLM consistently mis-selects a capability in chat-turn
   * (picks it when it shouldn't, or vice versa), and the capability is itself a
   * composition building block rather than a user-facing operation.
   */
  exposure?: PatternExposure

  /**
   * Catalog load strategy (default `'deferred'`). Orthogonal to `exposure`:
   * `exposure` governs "who can see this tool", `exposureMode` governs
   * "whether it's exposed directly as a standalone first-class tool
   * (`'always-load'`) or can only be discovered via find_pattern
   * (`'deferred'`)". Consumed by atomic only.
   *
   * Mark high-frequency generation atomics (those the main model can't do
   * itself, e.g. text-to-image / image-to-image) as `'always-load'` so the LLM
   * can call them in one step, skipping the find_pattern → dispatch_pattern
   * two-hop. Do NOT mark understanding / text atomics (image-to-text /
   * text-generation) — those should be handled by the main model directly, and
   * promoting them only encourages offloading the task to a weaker sub-tool.
   */
  exposureMode?: PatternExposureMode

  /**
   * The catalog namespace a Pattern statically belongs to.
   * AgentPattern.loop.toolNamespaces selects namespaces to decide which tools a
   * subagent sees; the catalog renders grouped by namespace and stays
   * byte-stable for the agent's lifetime.
   *
   * Optional — when not declared explicitly, the registry falls back to
   * inferNamespace(id) (see catalog.ts). All first-party Patterns should
   * eventually annotate this; kept optional for back-compat with existing
   * Patterns.
   */
  namespace?: NamespaceId

  /**
   * Whether third parties may attach extensions via
   * registry.attachAlternative. Default false (closed).
   *
   * Same philosophy as subagents defaulting to disallowing the Task tool:
   * capabilities are off by default, opened explicitly by the author. Holding
   * this invariant means a newly added third-party package can't accidentally
   * inject behavior into a first-party Pattern.
   */
  extensible?: boolean

  /**
   * The Pattern's preferred default execution mode.
   *   • atomic text-gen / image-to-text → 'sync' (LLM waits on the result to
   *     keep reasoning)
   *   • atomic image-gen / video-gen / audio-gen → 'async' (long-running)
   *   • meta / agent → 'async'
   *
   * When undeclared, the runtime falls back by kind + namespace (see
   * InlineRuntime config).
   *
   * NOTE: JobSpec-level override (`JobSpec.executionMode`) is a planned
   * follow-up — currently the field does not exist on JobSpec, so only the
   * Pattern-level default is honoured.
   */
  defaultExecutionMode?: 'sync' | 'async'

  /**
   * A Pattern's own permission-check hook. Another layer of ToS / quota /
   * scope validation beyond host middleware.
   *
   * Called before dispatch; on failure:
   *   • atomic / meta — dispatch throws PERMISSION_DENIED, the Job is marked
   *     'error'
   *   • agent — the PermissionResult is fed back to the LLM via onToolCall
   *
   * The actual rejection/confirmation UI is up to the host.
   */
  checkPermissions?: (
    input: I,
    ctx: DispatchContext,
  ) => Promise<PermissionResult> | PermissionResult

  /**
   * The author declares the asset slots this Pattern needs. Each element is a
   * semantic slot (`source` / `mask` / `reference` / `control` / `endFrame`
   * / ...), with modality + cardinality + required (+ an optional array upper
   * bound max?).
   *
   * The resolution pass uses this to resolve the handle the LLM fills
   * (`inputs.references`) into a real assetId landing in `ctx.assets`. This
   * declares intent only; it carries no resolution logic.
   */
  assetNeeds?: readonly AssetNeed[]
}

/**
 * Return type of Pattern.checkPermissions.
 *
 *   • ok=true                              → dispatch continues
 *   • ok=false, remedy='reauthorize'       → host guides the user to reauthorize
 *   • ok=false, remedy='reduce-scope'      → host narrows the input and retries
 *   • ok=false, remedy='manual'            → let the user handle it manually
 *   • ok=false, no remedy                  → plain rejection, no UI action hint
 *
 * Note: this is a synchronous permission gate, NOT a HITL seam. Mid-run "ask the
 * user" lives only on MetaPattern.compose via ctx.askUser — atomic confirms
 * (e.g. cost) are a host dispatch-policy concern (the host knows the routed
 * model + cost, which checkPermissions does not). See the seam-ownership spec.
 */
export type PermissionResult =
  | { ok: true }
  | {
      ok: false
      reason: string
      remedy?: 'reauthorize' | 'reduce-scope' | 'manual'
    }

/**
 * Standard shape of an LLM-facing tool descriptor — `PrimaryPath.tool` and
 * `MetaPattern.tool` are typed against it. Only `description` + `inputs`
 * are required; the behavioural hints (`isConcurrencySafe` /
 * `isDestructive` / docs) are host-scheduler extras.
 */
export interface ToolDescriptor<I = unknown> {
  /** Tool description the LLM sees (short, action-oriented). Optimised for tool-selection. */
  description: string

  /** Fields the LLM fills; excludes host-injected content (that goes through ctx). */
  inputs: ZodSchema<I>

  /**
   * Whether this tool can be called concurrently with others. The host
   * scheduler uses it to batch concurrent calls; default true (media
   * generation is mostly side-effect-free).
   */
  isConcurrencySafe?: (input: I) => boolean

  /**
   * Whether this is a destructive operation (mutates an asset / project
   * state). The UI uses it to decide whether to show a "confirm" button;
   * default false.
   */
  isDestructive?: (input: I) => boolean

  /**
   * Long-form docs for developers, not part of the LLM catalog. IDEs / docs
   * generators can consume this field.
   */
  longDescription?: string
}

/**
 * Pattern catalog visibility, generalized to **per-surface**.
 *
 * The old 3-state string (`'tool'` / `'agent-tool'` / `'no-tool'`) is
 * **retained** as a back-compat shorthand; existing first-party declarations
 * need no migration and are mapped by {@link resolveExposure} into the
 * equivalent per-surface set:
 *   - `'tool'` (old default) → visible to chat-turn + agent-loop
 *   - `'agent-tool'`         → visible to agent-loop only (chat-turn hidden)
 *   - `'no-tool'`            → invisible to every LLM catalog, host-direct
 *     submitJob only
 *
 * The new form declares visibility per surface with an object. Missing fields
 * **fail-closed**: LLM/user-facing surfaces (`chatTurn` / `agentLoop` /
 * `slash` / `canvas`) default to `false`; `host` defaults to `true`
 * (host-direct is always reachable, never blocked by any gate).
 *
 * Surfaces:
 *   - `chatTurn`  — the main chat-turn LLM catalog
 *   - `agentLoop` — the AgentPattern loop (subagent) catalog
 *   - `slash`     — slash-command exposure
 *   - `canvas`    — per-node canvas exposure
 *   - `host`      — host-direct `runtime.submitJob` (no LLM involved)
 */
export type PatternExposure = PatternExposureShorthand | PatternExposureMap

/**
 * Old 3-state string shorthand, retained for back-compat.
 */
export type PatternExposureShorthand = 'tool' | 'agent-tool' | 'no-tool'

/**
 * Per-surface visibility object form; missing fields fail-closed via {@link resolveExposure}.
 */
export interface PatternExposureMap {
  chatTurn?: boolean
  agentLoop?: boolean
  slash?: boolean
  canvas?: boolean
  host?: boolean
}

/**
 * Normalized output of {@link resolveExposure} — every surface has a definite boolean.
 * @alpha
 */
export interface ResolvedExposure {
  chatTurn: boolean
  agentLoop: boolean
  slash: boolean
  canvas: boolean
  host: boolean
}

/**
 * Normalize {@link PatternExposure} (string shorthand / object / undeclared)
 * into a definite per-surface boolean set. Every consumer that reads
 * `.exposure` should go through this function to get the boolean for its
 * surface, rather than comparing strings directly.
 *
 * Mapping rules (behavior is equivalent to the old string semantics):
 *   - `undefined` → `'tool'` default semantics
 *   - `'tool'`       → `{ chatTurn:true,  agentLoop:true,  slash:false, canvas:false, host:true }`
 *   - `'agent-tool'` → `{ chatTurn:false, agentLoop:true,  slash:false, canvas:false, host:true }`
 *   - `'no-tool'`    → `{ chatTurn:false, agentLoop:false, slash:false, canvas:false, host:true }`
 *   - object form → read per field, missing fields fail-closed (LLM/user-facing
 *     default false; `host` defaults true)
 *
 * `host` is never gated (host-direct is reachable), so `'no-tool'` still keeps
 * `host:true`.
 * @alpha
 */
export function resolveExposure(e?: PatternExposure): ResolvedExposure {
  if (e === undefined || e === 'tool') {
    return { chatTurn: true, agentLoop: true, slash: false, canvas: false, host: true }
  }
  if (e === 'agent-tool') {
    return { chatTurn: false, agentLoop: true, slash: false, canvas: false, host: true }
  }
  if (e === 'no-tool') {
    return { chatTurn: false, agentLoop: false, slash: false, canvas: false, host: true }
  }
  // Object form — fail-closed on missing LLM/user-facing surfaces; host
  // defaults open so host-direct dispatch is never gated.
  return {
    chatTurn: e.chatTurn ?? false,
    agentLoop: e.agentLoop ?? false,
    slash: e.slash ?? false,
    canvas: e.canvas ?? false,
    host: e.host ?? true,
  }
}

/**
 * Pattern catalog load strategy. `'always-load'` = promoted to a standalone
 * first-class tool (the descriptor enters the LLM tool table directly, callable
 * in one step); `'deferred'` (default) = discovered and called only via the
 * two-step find_pattern / dispatch_pattern. See PatternBase.exposureMode.
 */
export type PatternExposureMode = 'always-load' | 'deferred'

/**
 * Atomic Pattern — a single capability (no plan). Pattern : Capability = 1:1,
 * `id` is the capability literal. The primary path is required. The runtime
 * resolves one model.call to complete dispatch.
 *
 * Capability branches (ip-adapter / controlnet / inpaint / outpaint / etc.)
 * are expressed via `input.references` asset mounts + the provider's
 * self-reported typed `providerOptions` schema — not as separate fields on
 * the Pattern.
 */
export interface AtomicPattern<I = unknown, O = unknown>
  extends PatternBase<I, O>
{
  kind: 'atomic'
  /** Narrows base.primary to required — an atomic can't dispatch without primary. */
  primary: PrimaryPath<I>
}

/**
 * Meta Pattern — a plan known outside the runtime, orchestrated via
 * `compose()` over sub-steps.
 *
 * The compose form is a **plain async function**:
 *   compose(params, ctx) => Promise<O>
 *
 * - `params.input` is visually separated from ctx.step({input})'s inner field
 * - ctx.step / ctx.compute / parallel() freely orchestrate sub-Patterns + host
 *   code
 * - it no longer returns a static MetaPlan; it uses ctx.step / ctx.compute to
 *   orchestrate sub-Patterns
 *
 * Meta puts the LLM-facing `tool` at the top level (no primary wrapper); at
 * catalog-render time it emits one tool just like an atomic's primary.
 */
export interface MetaPattern<I = unknown, O = unknown>
  extends PatternBase<I, O>
{
  kind: 'meta'
  /** LLM-facing surface (top-level, no primary wrapper). */
  tool: ToolDescriptor<I>
  /**
   * Async compose. Returns `Promise<O>`, using `ctx.step` to orchestrate
   * sub-Patterns, `ctx.compute` to wrap expensive host functions, and
   * `parallel()` for fan-out.
   *
   * The `params: { input }` wrapper object exists to visually separate it from
   * step({input})'s inner field — `params.input` is always "my own input as a
   * Pattern", `step({input})` is always "the input to the sub-Pattern I'm
   * calling". Host-injected context (projectId / providerOptions) + resolution
   * results (`ctx.assets`) flow through `ctx`.
   */
  compose(
    params: { input: I },
    ctx: ExecutionContext,
  ): Promise<O>
}

/**
 * Runtime-supplied facts handed to {@link AgentFinishSpec.compose}. All
 * library vocabulary — the runtime resolves the finish payload's deliverable
 * handles against the run ledger and hands the results here alongside loop
 * metadata.
 */
export interface AgentRunFacts {
  /** Loop steps completed (host onStepFinish count). */
  stepCount: number
  usage?: { totalTokens?: number }
  /** The finish payload's deliverable handles, already resolved by the runtime
   *  against this run's ledger. */
  deliverables: readonly (ResolvedAssetRef & { label?: string })[]
}

/**
 * Agent finish contract: what the inner LLM must supply when it declares
 * completion (`inputs` → the finish tool's schema, projected to the model),
 * and how that payload + run facts compose into Pattern outputs.
 *
 * Type-erased on the interface (same precedent as Alternative<I,O> — the
 * registry stores `unknown`, authors bind TFinish via z.infer at the factory).
 */
export interface AgentFinishSpec<TFinish = unknown, TOut = unknown> {
  inputs: ZodSchema<TFinish>
  compose: (finish: TFinish, facts: AgentRunFacts) => TOut
}

/**
 * Agent Pattern — the plan is decided dynamically by the runtime's inner LLM
 * inside a loop. The Pattern author declares only the boundaries (system /
 * toolbox / stop conditions / model); the concrete behavior emerges reactively
 * as the LLM runs the loop in dispatchAgent → AgentRunImpl.
 *
 * `primary?` stays base-optional: present = an LLM-visible subagent (triggerable
 * by the parent chat-turn or a deeper AgentPattern tool-call); absent =
 * host-only (rare, scheduled tasks).
 */
export interface AgentPattern<I = unknown, O = unknown>
  extends Omit<PatternBase<I, O>, 'outputs'>
{
  kind: 'agent'

  /**
   * Public outputs schema. Optional on agents (base narrows it to required):
   * when both `finish` and `outputs` are omitted — and `loop.outputExtractor`
   * is absent — the registry backfills the default finish trio, so there is
   * nothing for the author to get wrong. Declaring `finish` requires declaring
   * `outputs` (the registry enforces both at boot).
   */
  outputs?: ZodSchema<O>

  /** Finish contract; mutually exclusive with loop.outputExtractor. */
  finish?: AgentFinishSpec<unknown, O>

  /** Loop config — fully declarative fields, no imperative logic outside closures. */
  loop: {
    /**
     * The inner LLM's system prompt (named after LLM providers' native ground
     * truth: Anthropic Messages `system` / OpenAI Chat `role: 'system'` /
     * Gemini `systemInstruction`). Some agent SDKs name this field
     * differently (e.g. `instructions`); the AgentRunImpl layer maps it
     * once, so this interface doesn't drift with any one SDK.
     *
     * The function form allows dynamic generation from (input, ctx) (itself a
     * host-side pure function, no LLM call, analogous to meta.compose()). `ctx`
     * is SystemPromptContext — i.e. DispatchContext minus `assets`: the system
     * prompt is a cached byte-stable prefix, so it intentionally excludes
     * resolved assets (those enter the loop via a cache-cold seed
     * announcement). When assembling from (input, ctx), the author should keep
     * it byte-stable. Tier-specific behavior goes through modelTags + Router
     * resolution, or by picking a different patternId per tier at host dispatch.
     */
    system: string | ((input: I, ctx: SystemPromptContext) => string)

    /**
     * The subset of the Pattern catalog visible to the inner LLM. Must be
     * listed explicitly (no '*' wildcard). dispatchAgent automatically filters
     * out the self id (prevents self-call recursion).
     */
    toolPatternIds: readonly PatternId[]

    /**
     * Second-stage catalog filter: when dispatchAgent detects this Pattern is
     * running in async mode (`defaultExecutionMode === 'async'`), the tool set
     * is pruned to `toolPatternIds ∩ asyncToolPatternIds`. (JobSpec-level
     * executionMode override is a follow-up, not yet implemented.)
     *
     * Purpose: for an async long-running subagent (e.g. media generation
     * 10-30 min) whose parent is waiting on the result, a tighter tool set is
     * better — it needn't access the full chat-turn toolset, and it prevents a
     * sub-tool calling a sub-tool from triggering an unnecessary cascade.
     *
     * undefined / empty array = no second filter; async sees the full set just
     * like sync. When running sync, this field is ignored.
     */
    asyncToolPatternIds?: readonly PatternId[]

    /** The inner LLM's model selection, resolved via CapabilityRouter (same mechanism as atomic). */
    modelTags: readonly ModelTag[]

    /**
     * Parent/child abort control:
     *
     * - `'inherit'` (default): the parent's abort signal propagates to the
     *   child — consistent with historical behavior, suitable for a sync
     *   subagent / short async task
     * - `'independent'`: the child agent starts a new AbortController, the
     *   parent's abort does not propagate; the child stops only via the host's
     *   stop policy / an explicit `runtime.cancelJob(childJobId)`. Suitable for
     *   async long-running media generation tasks where the parent closes the
     *   app and the child keeps running.
     *
     * `'independent'` only works fully alongside transcript persistence +
     * sanitize: parent closes app → child transcript keeps appending → parent
     * restarts and resumes.
     */
    abortMode?: 'inherit' | 'independent'

    /**
     * Optional hook to extract typed Pattern output from
     * the agent's final assistant text. By default (no `outputExtractor`)
     * the runtime injects the finish tool (`pattern.finish` or the default
     * `complete_task` envelope), intercepts its call, and composes the
     * Pattern output from the acknowledged finish payload + run facts —
     * AgentRunImpl.run() itself returns only `{ text, usage }`, never
     * structured outputs. For Patterns where the LLM produces typed data as
     * free-form text instead (e.g. a JSON plan in the last text block),
     * declaring `outputExtractor` tells the runtime to skip injecting the
     * finish tool altogether; `outputExtractor` then runs against
     * `result.text` and its return becomes the Pattern output. The result
     * still goes through `pattern.outputs.parse()` for schema validation.
     *
     * Typical usage: a director agent emits a final scene plan as JSON
     * in the last text block; `outputExtractor: (text) => JSON.parse(text)`
     * lifts it back to the typed Pattern output without needing a finish
     * tool round-trip.
     */
    outputExtractor?: (text: string) => unknown

    /**
     * Parent→agent asset inheritance policy. Default `false`:
     * the subagent sees only the assets explicitly passed via its
     * `inputs.references` (resolved at the parent's dispatch boundary). Set
     * `true` for autonomous-browse agents that should inherit ALL of the
     * parent context's currently-visible assets (re-announced into the child
     * transcript with child-local handles). No handle whitelist — handles are
     * runtime + per-context, so the author can't name them; to pass only
     * specific assets, use `assetNeeds` + `inputs.references`.
     */
    inheritParentAssets?: boolean
  }
}

/**
 * Loop stop-condition descriptor. A single-valued enum, not a predicate
 * closure (prevents a Pattern spec from carrying non-serializable runtime
 * logic). AgentRunImpl maps it as:
 *   • { kind: 'step-count', n } → ai-sdk `stepCountIs(n)`
 *   • { kind: 'token-count', n } → a custom isLoopFinished predicate that
 *                                  accumulates and compares steps[].usage.totalTokens
 * @alpha
 */
export type StopConditionDescriptor =
  | { kind: 'step-count'; n: number }
  | { kind: 'token-count'; n: number }

/** Discriminated union of every Pattern shape. */
export type Pattern<I = unknown, O = unknown> =
  | AtomicPattern<I, O>
  | MetaPattern<I, O>
  | AgentPattern<I, O>

/**
 * Main path of an atomic Pattern — the basic call shape with no special
 * strategy. Carries the LLM-facing tool spec plus the routing modelTag
 * preferences for this path.
 */
export interface PrimaryPath<I = unknown> {
  /** LLM-facing surface. Rendered into an LLM tool by catalog helpers. */
  tool: ToolDescriptor<I>
  /**
   * Model-feature preferences for the primary path. Usually `[]` (any
   * model satisfying the capability suffices). Some capabilities may
   * require a baseline tag — e.g. text-to-speech might want `streaming`.
   */
  modelTags?: readonly ModelTag[]
}

// ────────────────────────────────────────────────────────────────────────
// Runtime-emitted shapes — re-exported here for convenience.
// ────────────────────────────────────────────────────────────────────────

export interface Artifact {
  kind: 'image' | 'video' | 'audio' | 'text' | 'json'
  uri: string
  mime?: string
  meta?: Record<string, unknown>
}

/**
 * Runtime envelope for a `ModelCapability.call` result — the standard dispatch
 * return shape: output + optional artifacts + optional `terminate` hint for
 * meta-compose early-exit.
 */
export interface DispatchResult<O = unknown> {
  output: O
  /** Early-exit signal for the surrounding MetaPattern composition. */
  terminate?: boolean
  artifacts?: readonly Artifact[]
}
