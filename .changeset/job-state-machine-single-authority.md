---
'@orchestral/core': minor
---

**The job state machine is one exported function.** `nextJobState(prev, next)`
ships on the root entry of `@orchestral/core`, with `JobTransition`,
`JobLifecycleEventType`, and `JOB_TERMINAL_STATUSES`. It answers both halves of
what a `JobStore` needs to know about a status write: whether the move is legal,
and which `JobEvent` a legal one produces.

Both halves used to be unwritten. The transition → event map lived in a private
switch inside `InMemoryJobStore` — a dev-only store — so a durable host store
re-derived it from a comment. And "a terminal status is terminal" was asserted
in prose and enforced nowhere: `update()` checked that the status was a legal
*value*, not that the move was a legal *transition*, so `done → running` wrote
cleanly and emitted `job:started` after `job:completed`. No subscriber can tell
that apart from a job genuinely running again, which is what makes the bug worth
a function rather than a paragraph.

**`InMemoryJobStore` now refuses an illegal write** — `insert`,
`insertIfAbsent`, `update` and `conditionalUpdate` all ask `nextJobState` first
— and throws a coded `JOB_STORE_ILLEGAL_TRANSITION` error carrying
`details: { jobId, from, to }`. A refusal leaves the row and the subscribers
untouched, so a rejected patch cannot half-apply. `conditionalUpdate` throws
rather than returning `false`: `false` means "the row moved on", which a caller
retries, and an illegal move is not something to retry.

The refused set is exactly two rules. A terminal row (`done` / `error` /
`cancelled` / `stale`) never changes status again, and nothing moves back to
`queued`. Everything else is unchanged, including the one case worth naming: a
**same-status patch stays legal on a settled row** and still emits `job:output`.
Terminal means the status stops moving, not that the row freezes — a host
writing late output or metadata onto a `done` row keeps working.

No runtime path changes. Every write `@orchestral/runtime` makes was already
legal under this table (`queued → running → done`, the short-circuit
`queued → done`, `markErrored`, `abandonOrphanedJobs`' `queued|running → stale`,
and the cancel path's guarded `queued|running → cancelled`).

`JobStore.update`'s doc comment now states this as a conformance requirement,
in the same form `insertIfAbsent`'s atomicity requirement is stated. If you
maintain a durable store, call `nextJobState` from your write paths instead of
re-deriving the table.
