import { describe, expect, it } from 'vitest'

import type { JobStatus } from '../job'
import { JOB_TERMINAL_STATUSES, nextJobState } from '../job-state'

// The whole state machine, spelled out. This table IS the contract every
// conforming JobStore is judged against, so it is enumerated in full rather
// than sampled: an "everything else is refused" assertion passes just as
// happily on a function that also refuses a LEGAL transition, and the legal
// half is where the events live.

const ALL_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'done',
  'error',
  'cancelled',
  'stale',
]

type Expected = { ok: true; event: string } | { ok: false }

const REFUSED: Expected = { ok: false }

// prev -> next -> what nextJobState must answer.
const TABLE: Record<JobStatus, Record<JobStatus, Expected>> = {
  queued: {
    queued: { ok: true, event: 'job:output' },
    running: { ok: true, event: 'job:started' },
    done: { ok: true, event: 'job:completed' },
    error: { ok: true, event: 'job:failed' },
    cancelled: { ok: true, event: 'job:cancelled' },
    stale: { ok: true, event: 'job:stale' },
  },
  running: {
    queued: REFUSED,
    running: { ok: true, event: 'job:output' },
    done: { ok: true, event: 'job:completed' },
    error: { ok: true, event: 'job:failed' },
    cancelled: { ok: true, event: 'job:cancelled' },
    stale: { ok: true, event: 'job:stale' },
  },
  done: {
    queued: REFUSED,
    running: REFUSED,
    done: { ok: true, event: 'job:output' },
    error: REFUSED,
    cancelled: REFUSED,
    stale: REFUSED,
  },
  error: {
    queued: REFUSED,
    running: REFUSED,
    done: REFUSED,
    error: { ok: true, event: 'job:output' },
    cancelled: REFUSED,
    stale: REFUSED,
  },
  cancelled: {
    queued: REFUSED,
    running: REFUSED,
    done: REFUSED,
    error: REFUSED,
    cancelled: { ok: true, event: 'job:output' },
    stale: REFUSED,
  },
  stale: {
    queued: REFUSED,
    running: REFUSED,
    done: REFUSED,
    error: REFUSED,
    cancelled: REFUSED,
    stale: { ok: true, event: 'job:output' },
  },
}

describe('nextJobState — first write', () => {
  // A host replaying a finished run inserts the settled row directly, so any
  // status is a legal starting point; what subscribers are told about is the
  // row appearing, not which status it appeared in.
  for (const status of ALL_STATUSES) {
    it(`reports an initial ${status} row as job:submitted`, () => {
      expect(nextJobState(null, status)).toEqual({ ok: true, event: 'job:submitted' })
    })
  }
})

describe('nextJobState — full transition table', () => {
  for (const prev of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      const expected = TABLE[prev][next]
      const label = expected.ok ? expected.event : 'refused'
      it(`${prev} -> ${next} is ${label}`, () => {
        const result = nextJobState(prev, next)
        if (expected.ok) {
          expect(result).toEqual({ ok: true, event: expected.event })
        } else {
          // The reason has to name the status that was refused — it lands in
          // the store's thrown message, and a host debugging a rejected write
          // reads that message before it reads this table.
          expect(result).toEqual({
            ok: false,
            code: 'JOB_STORE_ILLEGAL_TRANSITION',
            reason: expect.stringContaining(next),
          })
        }
      })
    }
  }
})

describe('JOB_TERMINAL_STATUSES', () => {
  it('names exactly the four settlements', () => {
    expect([...JOB_TERMINAL_STATUSES].sort()).toEqual([
      'cancelled',
      'done',
      'error',
      'stale',
    ])
  })

  it('refuses every outward move from each of them', () => {
    for (const prev of JOB_TERMINAL_STATUSES) {
      for (const next of ALL_STATUSES) {
        if (next === prev) continue
        expect(nextJobState(prev, next).ok).toBe(false)
      }
    }
  })

  it('still allows the same-status patch on a settled row', () => {
    // Irreversibility is about the status never moving again, not about the
    // row freezing: an output / metadata write on a done row stays legal.
    for (const status of JOB_TERMINAL_STATUSES) {
      expect(nextJobState(status, status)).toEqual({ ok: true, event: 'job:output' })
    }
  })
})
