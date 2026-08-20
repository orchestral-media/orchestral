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
 * Per-call routing metadata the host derives from the calling agent.
 *
 * orchestral's asset handles (`image_1`, …) are minted per asset context and
 * collide across contexts, so a bridge that returns handles to a model must be
 * told which ledger those handles name. A host with no asset ledger simply
 * omits this — Patterns with no `assetNeeds` never consult it.
 */
export interface JobContext {
  sessionId?: string
  assetContextId?: string
  /** The host-owned asset ledger this call's `input.references` resolve against. */
  assetEvents?: readonly AssetEvent[]
}

/** The canonical value every bridged tool returns. */
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
        'Terminal status for a fresh dispatch; may be non-terminal when an idempotency dedup hit returned a job another submit owns.',
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

      if (jobCtx.sessionId !== undefined) spec.sessionId = jobCtx.sessionId
      if (jobCtx.assetContextId !== undefined) {
        spec.assetContextId = jobCtx.assetContextId
      }

      // `submitJob` REJECTS on a failed dispatch (it does not resolve with a
      // failed Job), so a Pattern failure propagates out of this body and dsh
      // normalizes it into an `isError` tool result carrying the message. The
      // non-`done` statuses handled below are the dedup-hit case, where the
      // returned row belongs to a submit this call does not own.
      const job = await runtime.submitJob(spec)

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
