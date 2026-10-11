// The fields a step's identity no longer goes through. A `ctx.step` is keyed
// by its path in the dispatch tree (`JobSpec.stepKey`): its name, or its
// position among its compose's unnamed calls to the same pattern. So there is
// no identity mode to pick, no position on the spec or the context, and no
// metadata bag beside the name. The assertions live in the type system — each
// `@ts-expect-error` goes unused, and tsc fails, the day a removed field comes
// back; the runtime bodies are a formality.
import { describe, expect, it } from 'vitest'

import type { ExecutionContext, StepOptions } from '../execution-context'
import type { JobSpec } from '../job'

describe('step identity surface', () => {
  it('StepOptions has a name and a key and no identity mode', () => {
    const options: StepOptions = {
      stepId: 'render',
      // @ts-expect-error — identity was removed: a named step is keyed by its name
      identity: 'id',
    }
    expect(options.stepId).toBe('render')
  })

  it('StepOptions has no metadata', () => {
    const options: StepOptions = {
      stepId: 'render',
      // @ts-expect-error — metadata was removed: nothing read it
      metadata: {},
    }
    expect(options.stepId).toBe('render')
  })

  it('JobSpec identifies a step by its path and never by a position', () => {
    const spec: JobSpec = {
      patternId: 'fake-gen',
      input: { prompt: 'a-1' },
      stepKey: 'a/fake-gen#0',
      // @ts-expect-error — a step is keyed by its path (stepKey), never by a position
      stepIndex: 0,
    }
    expect(spec.stepKey).toBe('a/fake-gen#0')
  })

  it('ExecutionContext has no stepIndex', () => {
    type Has = 'stepIndex' extends keyof ExecutionContext ? true : false
    const has: Has = false
    expect(has).toBe(false)
  })
})
