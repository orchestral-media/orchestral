// The adapter-contract version is enforced, not declared: the dispatch path
// checks `ModelCapability.specificationVersion` immediately before it calls
// `call`. This file pins all three arms of that claim —
//   • an adapter that declares nothing dispatches unchanged (undeclared = v1),
//   • an adapter that declares the current version dispatches,
//   • an adapter built for a generation this build cannot execute fails the
//     job with the stable MODEL_SPEC_VERSION_UNSUPPORTED code and never has
//     its `call` invoked.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
  AtomicPattern,
  CapabilityRouter,
  Modality,
  ModelCapability,
} from '@orchestral/core'
import {
  silentDiagnosticsLogger,
  MODEL_SPEC_VERSION,
  PatternRegistry,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore } from '@orchestral/core/memory'

import { InlineRuntime } from '../inline'

const TEXT_OUTPUT = z.object({ modality: z.literal('text'), text: z.string() })

function atomic(id: string): AtomicPattern {
  return {
    id,
    kind: 'atomic',
    description: `atomic ${id}`,
    exposure: 'agent-tool',
    outputs: TEXT_OUTPUT,
    primary: {
      tool: { description: id, inputs: z.object({ prompt: z.string() }) },
    },
  } as unknown as AtomicPattern
}

/**
 * `specificationVersion` is passed as a plain string so the test can hand the
 * runtime a version the type union does not admit — the case the compiler
 * cannot catch: an adapter package compiled against a newer @orchestral/core.
 */
function model(specificationVersion: string | undefined, calls: string[]): ModelCapability {
  return {
    modelId: 'm',
    provider: 'fake',
    tags: [] as never[],
    capabilities: ['text_cap'],
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    source: 'user' as const,
    ...(specificationVersion === undefined ? {} : { specificationVersion }),
    async call() {
      calls.push('called')
      return { output: { modality: 'text', text: 'ok' } }
    },
  } as unknown as ModelCapability
}

function harness(specificationVersion: string | undefined) {
  const calls: string[] = []
  const cap = model(specificationVersion, calls)
  const router: CapabilityRouter = {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  }
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  registry.register(atomic('text_cap'))
  const jobIds: string[] = []
  const rt = new InlineRuntime({
    store: new MemoryJobStore() as never,
    registry,
    router,
    onJobCreated: (jobId) => jobIds.push(jobId),
  })
  return { rt, calls, jobIds }
}

describe('ModelCapability.specificationVersion gate', () => {
  it.each([
    { label: 'undeclared (pre-versioning adapter)', version: undefined },
    { label: 'explicit current version', version: MODEL_SPEC_VERSION },
  ])('dispatches a supported adapter ($label)', async ({ version }) => {
    const { rt, calls } = harness(version)

    const job = await rt.submitJob({
      patternId: 'text_cap',
      input: { prompt: 'go' },
    })

    expect(job.status).toBe('done')
    expect(job.output).toEqual({ modality: 'text', text: 'ok' })
    expect(calls).toEqual(['called'])
  })

  it('refuses an adapter built for a future contract before calling it', async () => {
    const { rt, calls, jobIds } = harness('v2')

    const settled = await rt.submitJob({ patternId: 'text_cap', input: { prompt: 'go' } })

    expect(settled.status).toBe('error')
    expect(settled.error?.code).toBe('MODEL_SPEC_VERSION_UNSUPPORTED')
    // The whole point: the adapter whose signature we cannot honour is never
    // entered, so nothing half-runs against a contract this build cannot meet.
    expect(calls).toEqual([])

    // The host reads the failure off the job row, programmatically.
    const job = await rt.pollJob(jobIds[0]!)
    expect(job.status).toBe('error')
    const error = job.error!
    expect(error.code).toBe('MODEL_SPEC_VERSION_UNSUPPORTED')
    const diagnostic = (error.details as { diagnostic: Record<string, unknown> })
      .diagnostic
    expect(diagnostic.model).toBe('fake:m')
    expect(diagnostic.received).toBe('v2')
    expect(diagnostic.supported).toEqual([MODEL_SPEC_VERSION])
    expect(String(diagnostic.hint)).toContain('Upgrade')
    // …and the prose names both sides for a human reading a log.
    expect(error.message).toContain("'v2'")
    expect(error.message).toContain("'v1'")
  })
})
