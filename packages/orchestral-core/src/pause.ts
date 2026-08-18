// Human-in-the-loop vocabulary (in-stream park model). Leaf module — imports
// nothing from job.ts / pattern.ts so both can reference these without a cycle.

/** Interaction intent for ctx.askUser / AskUserRequest — what is being asked
 *  (choice→pick one, confirm→yes-no, form→edit fields), never how it is
 *  rendered. Single source so AskUserOptions.kind and AskUserRequest.kind
 *  can't drift. */
export type AskUserKind = 'choice' | 'confirm' | 'form'

/**
 * A typed mid-run request for user input, surfaced by the runtime to the host's
 * AskUserHandler. The pattern's compose() parks (awaits) until the host returns
 * the answer; there is no job 'pause' state — the job stays running.
 *
 * The payload and answer shape for each kind is defined by the schemas in
 * ask-user.ts (AskUserConfirmPayloadSchema, AskUserChoicePayloadSchema,
 * AskUserFormPayloadSchema and their answer counterparts) — that module is the
 * normative protocol, this type only carries the envelope.
 */

export interface AskUserRequest<TPayload = unknown> {
  /** Runtime-minted correlation id; the host routes the answer back by it. The
   *  runtime mints it on BOTH the meta (ctx.askUser) and atomic (checkPermissions
   *  ask-user) paths, so the host's `${jobId}:`-prefixed sweep stays correct. */
  id: string
  kind: AskUserKind
  payload: TPayload
  /** Dispatch session, so the host knows which conversation the question
   *  belongs to. */
  sessionId?: string
  /** The dispatched job id, so the host can attribute the question to the
   *  running job in its own UI. */
  jobId?: string
}
