// One exposed Pattern → one dsh `ToolDefinition`.
//
// The bridge is deliberately thin: it owns argument pass-through, the asset
// resolution pass, `runtime.submitJob`, and the model-side output projection.
// It owns NO media logic — that all lives in @orchestral/core + the Pattern.
//
// The load-bearing invariant is the last step: what a dsh agent sees is
// `sanitizeToolOutput(projectToolOutputForModel(job.output))`, never the raw
// job output. `projectToolOutputForModel` is orchestral's verifiable
// no-assetId boundary (it rebuilds `assets[]` from a whitelist and physically
// deletes any top-level `assetId`), and `sanitizeToolOutput` is the binary
// scrubber that keeps a stray data: URL from burning the agent's context.
import {
  projectToolOutputForModel,
  sanitizeToolOutput,
  type AssetEvent,
  type Job,
  type JobSpec,
  type Pattern,
  type Runtime,
} from '@orchestral/core'
import { resolveAssets } from '@orchestral/runtime'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { PatternToolDescriptor } from './expose'

/**
 * Per-call routing metadata for one dispatch. Two unrelated concerns ride
 * here, and conflating them is how a bridge leaks one session's work into
 * another's.
 *
 * `sessionId` is the IDEMPOTENCY ISOLATION BOUNDARY. `deriveIdempotencyKey`
 * hashes it — "dedup never crosses a session boundary" — so two dispatches of
 * the same Pattern over the same input collapse into one job exactly when
 * they agree on it. Left undefined everywhere, every dsh session shares one
 * dedup space and the second session's model is handed the first session's
 * output and handles. That is why the bridge DERIVES it (from the calling
 * agent, see `buildPatternTool`) instead of leaving it to host wiring; this
 * field only overrides that default.
 *
 * `assetContextId` / `assetEvents` are the asset-ledger concern: orchestral's
 * handles (`image_1`, …) are minted per asset context and collide across
 * contexts, so a bridge that returns handles to a model must be told which
 * ledger names them. A host with no asset ledger omits both — Patterns with
 * no `assetNeeds` never consult them.
 */
export interface JobContext {
  /**
   * Override the derived dedup boundary. Set it to WIDEN one (several dsh
   * agents sharing a tenant's cached work) or to NARROW one (a per-request
   * scope inside one long-lived agent); leave it out to get the agent's own
   * session.
   */
  sessionId?: string
  assetContextId?: string
  /** The host-owned asset ledger this call's `input.references` resolve against. */
  assetEvents?: readonly AssetEvent[]
}

/**
 * The canonical value every bridged tool returns.
 *
 * A failed or cancelled dispatch never becomes one of these: it is thrown as
 * a tool error (see `describeDispatchFailure`), so the only non-`done` status
 * a model sees here is an idempotency dedup hit on a job another submit owns.
 */
export interface PatternToolResult {
  jobId: string
  patternId: string
  status: Job['status']
  /** Model-facing projection of the Pattern output; absent when not `done`. */
  output?: unknown
}

/**
 * dsh validates `output.schema` against its own enforced JSON Schema subset at
 * registration time (single `type`, `properties`/`required`/boolean
 * `additionalProperties`, `items`, scalar `enum`/`const`, exact-one `oneOf` —
 * anything else REJECTS rather than being silently unenforced). This envelope
 * is written to sit inside that subset; `output` is deliberately an
 * annotation-only node, dsh's documented form for unconstrained JSON, because
 * the shape varies per Pattern.
 */
export const PATTERN_TOOL_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: {
      type: 'string',
      description: 'orchestral Job id for this dispatch.',
    },
    patternId: {
      type: 'string',
      description: 'The orchestral Pattern that served the call.',
    },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'done', 'error', 'cancelled', 'stale'],
      description:
        '`done` for a fresh dispatch (a failed or cancelled one is reported as a tool error instead); may be non-terminal when an idempotency dedup hit returned a job another submit owns.',
    },
    output: {
      description:
        'Pattern output, projected for the model: produced assets carry an opaque handle + asset:// URI, never a real assetId or provider URL.',
    },
  },
  required: ['jobId', 'patternId', 'status'],
}

/** Everything a bridged tool closure needs, resolved once at plugin load. */
export interface BuildToolOptions {
  runtime: Runtime
  pattern: Pattern
  descriptor: PatternToolDescriptor
  /** Host hook for per-call session / asset-ledger routing. */
  resolveJobContext?: (args: unknown) => JobContext
  /** Forwarded to dsh's timeout policy; omit for no deadline. */
  timeoutMs?: number
}

function describeResolutionFailure(
  patternId: string,
  error: { code: string; slot?: string; handle?: string },
): string {
  const where = error.slot ?? error.handle ?? 'input.references'
  return `ASSET_RESOLUTION_FAILED (${error.code}) dispatching ${patternId}: ${where}`
}

/**
 * orchestral hands a failed dispatch back as data — a Job with
 * `status: 'error'` and a structured `JobError`. dsh's tool contract has one
 * channel for a failed call, a thrown error that it normalizes into an
 * `isError` result, so the JobError is re-raised here in orchestral's own
 * `CODE: message` form: the model reads the code and decides whether to retry
 * with different input or re-plan. Runtime messages already lead with their
 * code, so the prefix is added only when the message does not carry it. A
 * cancel and a stale row carry no JobError and are named by their status.
 */
function describeDispatchFailure(job: Job): string {
  if (job.status === 'cancelled') {
    return `CANCELLED: dispatch of ${job.patternId} was cancelled before completion`
  }
  if (job.status === 'stale') {
    return `JOB_STALE: dispatch of ${job.patternId} was abandoned by a runtime that did not survive it`
  }
  const code = job.error?.code ?? 'DISPATCH_FAILED'
  const message = job.error?.message ?? `dispatch of ${job.patternId} failed`
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`
}

/**
 * Build the dsh `ToolDefinition` for one exposed Pattern.
 *
 * This is a RAW ToolDefinition rather than a `defineTool(...)` call, and that
 * is deliberate: `defineTool` compiles dsh's own `ParameterSchemaSpec` DSL into
 * JSON Schema, but a Pattern already owns a zod input schema whose JSON-Schema
 * projection is the contract @orchestral/core hands every other host. Round
 * tripping it through the DSL would lose constraints the DSL cannot express.
 * dsh explicitly supports this path — a raw definition owns its own input
 * validation — which here is the Pattern's own dispatch-time validation.
 */
export function buildPatternTool(opts: BuildToolOptions): ToolDefinition {
  const { runtime, pattern, descriptor } = opts
  const assetNeeds = pattern.assetNeeds ?? []

  return {
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    output: {
      schema: PATTERN_TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
      ],
    },
    async execute(args, exec) {
      // Cheap correctness win: never open a provider-billed dispatch for a call
      // the caller already abandoned. Mid-flight cancellation is NOT available
      // to this plugin — orchestral's `submitJob` takes no AbortSignal, and
      // correlating a jobId early requires `InlineRuntimeInit.onJobCreated`,
      // which is set when the host CONSTRUCTS the runtime. Since this plugin
      // deliberately does not construct the runtime, a host that needs
      // cancellation wires onJobCreated → `runtime.cancelJob` itself.
      exec.signal.throwIfAborted()

      const jobCtx = opts.resolveJobContext?.(args) ?? {}

      const spec: JobSpec = { patternId: pattern.id, input: args }

      if (assetNeeds.length > 0) {
        // Fails closed: a missing required slot, an unknown handle, or a
        // modality mismatch is reported to the model instead of being
        // dispatched with a silently dropped attachment.
        const resolved = resolveAssets(
          args as { references?: Record<string, string | string[]> } | null,
          assetNeeds,
          jobCtx.assetEvents ?? [],
        )
        if (!resolved.ok) {
          throw new Error(describeResolutionFailure(pattern.id, resolved.error))
        }
        spec.assets = resolved.assets
      }

      // The dedup boundary, derived rather than configured. dsh's `Agent.id`
      // IS a `SessionId` — "the single identity shared with session" — and it
      // is the only session-scale identity on the tool-call surface:
      // `callId` / `rootCallId` are per-call, so hashing either would defeat
      // dedup outright. A call arriving with no `agent` is not a loop turn
      // (a host-direct execution) and has no session to belong to, so it is
      // left unscoped rather than given a fabricated one.
      const sessionId = jobCtx.sessionId ?? exec.agent?.id
      if (sessionId !== undefined) spec.sessionId = sessionId
      if (jobCtx.assetContextId !== undefined) {
        spec.assetContextId = jobCtx.assetContextId
      }

      // `submitJob` resolves with the Job in whatever terminal state it
      // reached — a failed dispatch is `status: 'error'` with its JobError on
      // the row, a cancel is `status: 'cancelled'` — and rejects only when the
      // request never became a job (an unregistered Pattern, an input no
      // idempotency key can be derived from). Either way dsh hears about it
      // the one way its contract allows, a throw, which it normalizes into an
      // `isError` result. The non-`done` statuses that reach the result below
      // are the dedup-hit case, where the returned row belongs to a submit
      // this call does not own.
      const job = await runtime.submitJob(spec)
      if (job.status === 'error' || job.status === 'cancelled' || job.status === 'stale') {
        throw new Error(describeDispatchFailure(job))
      }

      const result: PatternToolResult = {
        jobId: job.id,
        patternId: job.patternId,
        status: job.status,
      }
      if (job.status === 'done' && job.output !== null) {
        // Order matters: project FIRST (drops assetIds and rebuilds assets[]
        // from a whitelist), sanitize SECOND (scrubs data: URLs / binary runs
        // that survived inside the projected metadata).
        result.output = sanitizeToolOutput(
          projectToolOutputForModel(job.output),
        )
      }
      return result
    },
  }
}
