// Typed authoring facade over the generic ctx.askUser HITL primitive, plus the
// normative wire protocol for the three built-in interaction kinds.
//
// The generic form (ctx.askUser.custom) takes a `kind` plus an opaque `payload`
// the author must hand-shape, and an answerSchema — with no compile-time guard,
// and a question that, unlike the answer, isn't typed. The per-kind methods
// below move that question/answer contract into the library: the author passes
// typed inputs, the facade builds the payload and a validating answer schema,
// and unwraps the answer envelope to the value the author wants. Meta-only —
// HITL for agent / atomic patterns is a host concern.
//
// PROTOCOL. A host implementing AskUserHandler MUST accept these payloads and
// MUST return the matching answer, keyed on AskUserRequest.kind:
//
//   kind 'confirm' → AskUserConfirmPayload → AskUserConfirmAnswer
//   kind 'choice'  → AskUserChoicePayload  → AskUserChoiceAnswer
//   kind 'form'    → AskUserFormPayload    → AskUserFormAnswer
//
// The schemas are exported so a host can parse the payload it receives and
// validate the answer it produces against the same definition the facade uses;
// they are the single source of truth for both sides. `kind` names the
// interaction, not a widget — how it is rendered is entirely the host's
// choice. The runtime bridge (not the facade) runs answerSchema.parse, so the
// value `ask` resolves with is already validated.
//
// A host may accept richer payloads under an existing kind (e.g. a multi-select
// 'choice'); authors reach those through `custom`, which is why `custom` carries
// its own answerSchema.

import { z } from 'zod'
import type { AskUserOptions } from './execution-context'

/** A `form` field value. Typed per field, so a number field comes back a
 *  number and a boolean a boolean — never a stringified value. */
export const AskUserFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
])
export type AskUserFieldValue = z.infer<typeof AskUserFieldValueSchema>

/** One editable field in a `form` ask. `type` names the input's data kind. */
export const AskUserFormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'select', 'boolean']),
  value: AskUserFieldValueSchema.optional(),
})
export type AskUserFormField = z.infer<typeof AskUserFormFieldSchema>

/** `kind: 'confirm'` — a yes/no question. */
export const AskUserConfirmPayloadSchema = z.object({
  title: z.string(),
  body: z.string().optional(),
})
export type AskUserConfirmPayload = z.infer<typeof AskUserConfirmPayloadSchema>

export const AskUserConfirmAnswerSchema = z.object({ confirmed: z.boolean() })
export type AskUserConfirmAnswer = z.infer<typeof AskUserConfirmAnswerSchema>

/** `kind: 'choice'` — pick one of `options`. `value` is what comes back in
 *  `chosen`; `label` is what the user reads. */
export const AskUserChoicePayloadSchema = z.object({
  title: z.string(),
  mode: z.literal('single'),
  options: z.array(z.object({ label: z.string(), value: z.string() })),
})
export type AskUserChoicePayload = z.infer<typeof AskUserChoicePayloadSchema>

export const AskUserChoiceAnswerSchema = z.object({ chosen: z.string() })
export type AskUserChoiceAnswer = z.infer<typeof AskUserChoiceAnswerSchema>

/** `kind: 'form'` — review / edit a set of fields. */
export const AskUserFormPayloadSchema = z.object({
  title: z.string(),
  fields: z.array(AskUserFormFieldSchema),
})
export type AskUserFormPayload = z.infer<typeof AskUserFormPayloadSchema>

export const AskUserFormAnswerSchema = z.object({
  values: z.record(z.string(), AskUserFieldValueSchema),
})
export type AskUserFormAnswer = z.infer<typeof AskUserFormAnswerSchema>

/** The generic primitive the facade wraps — the runtime's raw ctx.askUser,
 *  surfaced as `ctx.askUser.custom` for interaction shapes the three built-in
 *  kinds don't cover. */
export type AskUserGeneric = <TPayload = unknown, TAnswer = unknown>(
  opts: AskUserOptions<TPayload, TAnswer>,
) => Promise<TAnswer>

/**
 * Typed mid-run HITL surface (ctx.askUser). Each method parks compose() on a
 * human and resolves with the unwrapped answer. Meta-only.
 */
export interface AskUser {
  /** Yes/no. Resolves true iff the user confirmed (cancel → false). */
  confirm(input: { title: string; body?: string }): Promise<boolean>
  /** Single pick from `options`; resolves with the chosen one. Hosts that
   *  accept a richer 'choice' payload (multi-select and the like) are reached
   *  through `custom`. */
  choose<const T extends string>(input: {
    title: string
    options: readonly T[]
  }): Promise<T>
  /** Review/edit a set of fields; resolves with key→value. */
  form(input: {
    title: string
    fields: readonly AskUserFormField[]
  }): Promise<Record<string, AskUserFieldValue>>
  /** Escape hatch — the raw generic, for an interaction shape outside the three
   *  built-in kinds. The author owns the payload contract and the answerSchema. */
  custom: AskUserGeneric
}

/**
 * Build the typed facade from the runtime's generic askUser. Pure: the per-kind
 * payload shaping, validating schema, and answer-envelope unwrapping all live
 * here, so they're unit-testable without the runtime and can't drift per host.
 */
export function buildAskUserFacade(ask: AskUserGeneric): AskUser {
  return {
    confirm: async ({ title, body }) => {
      const answer = await ask<AskUserConfirmPayload, AskUserConfirmAnswer>({
        kind: 'confirm',
        payload: { title, ...(body !== undefined ? { body } : {}) },
        answerSchema: AskUserConfirmAnswerSchema,
      })
      return answer.confirmed
    },

    choose: async <const T extends string>({
      title,
      options,
    }: {
      title: string
      options: readonly T[]
    }): Promise<T> => {
      const answer = await ask<AskUserChoicePayload, AskUserChoiceAnswer>({
        kind: 'choice',
        payload: {
          title,
          mode: 'single',
          options: options.map((o) => ({ label: o, value: o })),
        },
        answerSchema: AskUserChoiceAnswerSchema,
      })
      // The schema only guarantees a string; the T cast needs membership too.
      if (!options.includes(answer.chosen as T)) {
        throw new Error(
          `askUser.choose: host returned "${answer.chosen}", which is not one of the offered options`,
        )
      }
      return answer.chosen as T
    },

    form: async ({ title, fields }) => {
      const answer = await ask<AskUserFormPayload, AskUserFormAnswer>({
        kind: 'form',
        payload: { title, fields: [...fields] },
        answerSchema: AskUserFormAnswerSchema,
      })
      return answer.values
    },

    custom: ask,
  }
}
