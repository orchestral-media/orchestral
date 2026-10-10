// cancelJob's "already terminal" refusal reads core's set, not a copy of it.
//
// Which statuses end a job is core's to say: JOB_TERMINAL_STATUSES is the set
// nextJobState enforces, exported so a store, a UI and a runtime read one list.
// cancelJob used to spell the four out by hand. A copy agrees only until core's
// set moves, and then it disagrees quietly — a status core newly calls terminal
// would get a silent no-op from cancelJob (both guarded writes miss) instead of
// JOB_ALREADY_TERMINAL.
//
// The table iterates core's export — every member refuses, every other status
// is cancelled — so it grows with the set instead of pinning four, and the
// `satisfies` below keeps the complement honest as the union grows. There is
// no seam test perturbing core's set: a copy that agrees with it today behaves
// exactly like a read of it until the set moves, and then this table,
// regenerated from the real export against the real runtime and store, fails
// on the copy anyway — and commit 2057cdd's message records the one-time
// perturbation that proved cancelJob reads the export.

import { describe, expect, it } from 'vitest'

import type { Job, JobEvent, JobStatus } from '@orchestral/core'
import {
  JOB_TERMINAL_STATUSES,
  PatternRegistry,
  silentDiagnosticsLogger,
} from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

// Every JobStatus, spelled so the compiler holds it to the union: a status
// added to core without a line here fails `satisfies`, and the complement
// below would otherwise silently skip it.
const ALL_STATUSES = Object.keys({
  queued: true,
  running: true,
  done: true,
  error: true,
  cancelled: true,
  stale: true,
} satisfies Record<JobStatus, true>) as JobStatus[]

function row(status: JobStatus): Job {
  const now = Date.now()
  return {
    id: `job-${status}`,
    patternId: 'p' as Job['patternId'],
    idempotencyKey: `k-${status}`,
    status,
    input: {},
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  }
}

// A first write is legal from any status (nextJobState rule 1), so a settled
// row can be seeded directly. cancelJob never reaches the router.
async function seeded(status: JobStatus) {
  const store = new InMemoryJobStore()
  await store.insert(row(status))
  const runtime = new InlineRuntime({
    router: {} as never,
    registry: new PatternRegistry({ logger: silentDiagnosticsLogger }),
    store,
  })
  return { store, runtime, id: `job-${status}` }
}

describe('cancelJob and core’s terminal set', () => {
  it('the table covers both sides of the split', () => {
    const nonTerminal = ALL_STATUSES.filter((s) => !JOB_TERMINAL_STATUSES.includes(s))
    expect(JOB_TERMINAL_STATUSES.length).toBeGreaterThan(0)
    expect(nonTerminal.length).toBeGreaterThan(0)
  })

  for (const status of JOB_TERMINAL_STATUSES) {
    it(`refuses a ${status} job with JOB_ALREADY_TERMINAL and leaves the row alone`, async () => {
      const { store, runtime, id } = await seeded(status)

      await expect(runtime.cancelJob(id)).rejects.toMatchObject({
        code: 'JOB_ALREADY_TERMINAL',
      })
      expect((await store.get(id))!.status).toBe(status)
    })
  }

  for (const status of ALL_STATUSES.filter((s) => !JOB_TERMINAL_STATUSES.includes(s))) {
    it(`cancels a ${status} job and fans out job:cancelled`, async () => {
      const { store, runtime, id } = await seeded(status)
      const events: JobEvent['type'][] = []
      runtime.subscribe(id, (ev) => events.push(ev.type))

      await expect(runtime.cancelJob(id)).resolves.toBeUndefined()
      expect((await store.get(id))!.status).toBe('cancelled')
      expect(events).toEqual(['job:cancelled'])
    })
  }
})
