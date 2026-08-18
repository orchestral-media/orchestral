// Agent finish contract defaults.
//
// Knowledge split — each side states only what it can know:
//   • the model supplies a summary plus the deliverable HANDLES it can see;
//     it never sees or writes an asset id.
//   • the runtime resolves those handles to real assets and supplies the run
//     facts (deliverables, step count) the model cannot observe.
//   • `compose(finish, facts)` merges the two into the Pattern's declared
//     `outputs`, so the outputs schema — not the model — decides the shape.
// The projection layer strips asset ids from tool results, which is what makes
// handles the only asset language available to the model.
//
// A host overrides `AgentFinishSpec.inputs` / `compose` to change the finish
// payload; the tool NAME stays fixed (see AGENT_FINISH_TOOL_NAME).
import { z } from 'zod'

import type { AgentToolDescriptor } from './catalog-builder'
import { assetIdField, boundedText } from './output-fields'
import type { AgentFinishSpec, AgentRunFacts } from './pattern'
import { toJsonSchema } from './schema'

/** Wire name of the finish tool. Hosts key loop-rescue and budget attribution
 *  on this tool name; keeping the wire name stable leaves them untouched. */
export const AGENT_FINISH_TOOL_NAME = 'complete_task'

export const defaultAgentFinishInputs = z.object({
  summary: z
    .string()
    .min(1)
    .describe('Short natural-language summary of what was accomplished.'),
  deliverables: z
    .array(
      z.object({
        handle: z
          .string()
          .min(1)
          .describe(
            'Handle of one final deliverable asset (e.g. "image_2"), exactly ' +
              'as shown in the asset list provided in context or in a tool ' +
              'result. Never a raw asset id or URL.',
          ),
        label: z
          .string()
          .optional()
          .describe('Optional short human-readable label for this deliverable.'),
      }),
    )
    .default([])
    .describe(
      'The final deliverable assets of this run, by handle. Include only end ' +
        'products, not intermediates. Empty for purely textual results.',
    ),
})
export type DefaultAgentFinishInput = z.infer<typeof defaultAgentFinishInputs>

export const defaultAgentFinishOutputs = z.object({
  // Canonical produced-asset channel: extractOutputAssetIds /
  // recordJobOutputAssets recognise produced assets via assets[].assetId
  // (assetId-only contract). Every string field carries an explicit upper
  // bound (invariant #13 companion) so an unbounded base64 blob is
  // unrepresentable at the source; the TS-visible type stays plain string.
  // modality is a short enum-like value — consumers still gate with their
  // own isAssetKind check.
  assets: z.array(
    z.object({
      assetId: assetIdField(),
      modality: boundedText(32),
      label: boundedText(256).optional(),
    }),
  ),
  summary: boundedText(4_096),
  stepCount: z.number().int().min(0),
})
export type DefaultAgentFinishOutput = z.infer<typeof defaultAgentFinishOutputs>

export function defaultAgentFinishCompose(
  finish: DefaultAgentFinishInput,
  facts: AgentRunFacts,
): DefaultAgentFinishOutput {
  return {
    assets: facts.deliverables.map((d) => ({
      assetId: d.assetId,
      modality: d.modality,
      ...(d.label !== undefined ? { label: d.label } : {}),
    })),
    summary: finish.summary,
    stepCount: facts.stepCount,
  }
}

export const DEFAULT_AGENT_FINISH_SPEC: AgentFinishSpec = {
  inputs: defaultAgentFinishInputs,
  compose: (finish, facts) =>
    defaultAgentFinishCompose(finish as DefaultAgentFinishInput, facts),
}

/** zod→JSON-Schema serialisation stays in core (runtime has no zod dep). */
export function buildFinishDescriptor(
  inputs: AgentFinishSpec['inputs'],
): AgentToolDescriptor {
  return {
    name: AGENT_FINISH_TOOL_NAME,
    description:
      'Signal that the current task is complete. Call this exactly once when ' +
      'you have the final result, then stop emitting tool calls. Your payload ' +
      "becomes the run's structured outputs.",
    inputSchema: toJsonSchema(inputs),
  }
}
