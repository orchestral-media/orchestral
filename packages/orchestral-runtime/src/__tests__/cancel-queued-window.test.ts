// A cancel that lands while the row is still `queued`.
//
// `cancelJob` is not only for a running job. Between the queued INSERT and the
// `status: 'running'` write, submitJob runs the beforeDispatch middleware chain
// — every await in it is a window where a cancel can land, and in that window
// there is no AbortController registered yet (submitJob creates it after the
// running write), so the abort half of cancelJob is a no-op and only the store
// write happens.
//
// Both halves of the outcome are pinned here because both used to be wrong in
// a way nothing would notice:
//   • the row must STAY cancelled. submitJob's `status: 'running'` write is
//     unconditional, so before the store consulted `nextJobState` it happily
//     reopened a settled row — a cancelled job silently resuming.
//   • no `job:started` may follow `job:cancelled`. A subscriber that saw
//     cancelled-then-started has no way to tell that from a live job, which is
//     exactly the failure job-state.ts was written to make impossible.
//
// This sits at the public boundary on purpose — a real InMemoryJobStore, a real
// submitJob, a real cancelJob — because the guard being tested lives in the
// store and the caller being tested is the runtime. Faking either end would
// test the test.
//
// Scope: the top-level submitJob path only. The nested `_submitJobInternal`
// path a meta step takes is parked by a separate ruling and deliberately not
// touched here.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  DispatchMiddleware,
  JobEvent,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import { PatternRegistry, silentDiagnosticsLogger } from '@orchestral/core'
import { InMemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

// The model must never be reached: the cancel lands before dispatch. `called`
// is what proves it rather than assumes it.
function makeRouter(called: { count: number }): CapabilityRouter {
  const cap = {
    modelId: 'fake:m',
    provider: 'fake',
    tags: [] as never[],
    capabilities: [] as never[],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    async call() {
      called.count++
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
}

function makeRegistry(): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register({
    id: 'slow_atomic',
    kind: 'atomic',
    description: 'an atomic whose dispatch never gets to start',
    outputs: z.object({ modality: z.literal('text'), text: z.string() }),
    primary: {
      tool: { description: 'do the thing', inputs: z.object({ prompt: z.string() }) },
    },
  } as unknown as AtomicPattern)
  return registry
}

describe('a cancel that lands in the queued window', () => {
  it('leaves the row cancelled and emits no job:started after job:cancelled', async () => {
    const called = { count: 0 }
    const store = new InMemoryJobStore()
    const events: JobEvent['type'][] = []
    let jobId: string | undefined

    // beforeDispatch is the awaited seam that runs while the row is still
    // 'queued' — a stand-in for any host middleware slow enough for a user to
    // hit cancel during it (a moderation call, a cache lookup over the wire).
    const cancelDuringQueued: DispatchMiddleware = {
      async beforeDispatch() {
        await runtime.cancelJob(jobId as string, 'user changed their mind')
        return undefined
      },
    }

    const runtime = new InlineRuntime({
      store: store as never,
      registry: makeRegistry(),
      router: makeRouter(called),
      middleware: [cancelDuringQueued],
      // Fires synchronously right after the queued INSERT, which is both how
      // the cancel gets an id to aim at and where the subscription is attached
      // early enough to observe every lifecycle event.
      onJobCreated: (id) => {
        jobId = id
        runtime.subscribe(id, (ev) => events.push(ev.type))
      },
    })

    // Public submitJob turns the internal throw back into the persisted row
    // whenever that row reached terminal — so the caller is handed the cancel
    // as a fact rather than as an exception. What it must never be handed is a
    // Job claiming to have run.
    const job = await runtime.submitJob({
      patternId: 'slow_atomic',
      input: { prompt: 'go' },
    })
    expect(job.status).toBe('cancelled')
    expect(job.output).toBeNull()

    const row = await store.get(jobId as string)
    expect(row?.status).toBe('cancelled')
    expect(row?.output).toBeNull()
    expect(called.count).toBe(0)

    expect(events).toContain('job:cancelled')
    // The absence is the claim: a subscriber that saw started-after-cancelled
    // would read this job as still in flight. Stated as an ordering claim as
    // well, so a 'job:started' reintroduced from anywhere else has to land
    // BEFORE the cancel to pass (absent scores -1, which satisfies it).
    expect(events).not.toContain('job:started')
    expect(events.indexOf('job:started')).toBeLessThan(
      events.indexOf('job:cancelled'),
    )
  })

  it('still runs a job nobody cancelled (the window is not a hole)', async () => {
    const called = { count: 0 }
    const store = new InMemoryJobStore()
    const events: JobEvent['type'][] = []

    const runtime = new InlineRuntime({
      store: store as never,
      registry: makeRegistry(),
      router: makeRouter(called),
      onJobCreated: (id) => runtime.subscribe(id, (ev) => events.push(ev.type)),
    })

    const job = await runtime.submitJob({
      patternId: 'slow_atomic',
      input: { prompt: 'go' },
    })

    expect(job.status).toBe('done')
    expect(called.count).toBe(1)
    expect(events).toContain('job:started')
    expect(events).not.toContain('job:cancelled')
  })
})
