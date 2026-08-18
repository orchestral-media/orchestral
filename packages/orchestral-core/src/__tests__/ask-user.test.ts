import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildAskUserFacade, type AskUserGeneric } from '../ask-user'
import type { AskUserOptions } from '../execution-context'

// A stand-in for the runtime's raw ctx.askUser: it records the opts the facade
// built and, like the real runtime bridge, runs opts.answerSchema.parse over a
// canned raw answer before returning. So these tests lock BOTH the payload the
// facade shapes AND that its per-kind schema validates + unwraps correctly.
function mockAsk(rawAnswer: unknown): {
  ask: AskUserGeneric
  calls: AskUserOptions<unknown, unknown>[]
} {
  const calls: AskUserOptions<unknown, unknown>[] = []
  const ask = (<TPayload, TAnswer>(
    opts: AskUserOptions<TPayload, TAnswer>,
  ): Promise<TAnswer> => {
    calls.push(opts as unknown as AskUserOptions<unknown, unknown>)
    const a = opts.answerSchema ? opts.answerSchema.parse(rawAnswer) : rawAnswer
    return Promise.resolve(a as TAnswer)
  }) as AskUserGeneric
  return { ask, calls }
}

describe('buildAskUserFacade — confirm', () => {
  it('builds a confirm payload and unwraps {confirmed} → boolean', async () => {
    const { ask, calls } = mockAsk({ confirmed: true })
    const ok = await buildAskUserFacade(ask).confirm({ title: 'Proceed?' })
    expect(ok).toBe(true)
    expect(calls[0]!.kind).toBe('confirm')
    expect(calls[0]!.payload).toEqual({ title: 'Proceed?' })
  })

  it('includes body only when provided', async () => {
    const { ask, calls } = mockAsk({ confirmed: false })
    const ok = await buildAskUserFacade(ask).confirm({ title: 'Delete?', body: 'cannot undo' })
    expect(ok).toBe(false)
    expect(calls[0]!.payload).toEqual({ title: 'Delete?', body: 'cannot undo' })
  })

  it('rejects an answer missing confirmed (schema guards the host envelope)', async () => {
    const { ask } = mockAsk({ nope: 1 })
    await expect(buildAskUserFacade(ask).confirm({ title: 'x' })).rejects.toThrow()
  })
})

describe('buildAskUserFacade — choose', () => {
  it('maps string options to {label,value}, single mode, and returns chosen', async () => {
    const { ask, calls } = mockAsk({ mode: 'single', chosen: 'beta' })
    const chosen = await buildAskUserFacade(ask).choose({
      title: 'Pick one',
      options: ['alpha', 'beta', 'gamma'],
    })
    expect(chosen).toBe('beta')
    expect(calls[0]!.kind).toBe('choice')
    expect(calls[0]!.payload).toEqual({
      title: 'Pick one',
      mode: 'single',
      options: [
        { label: 'alpha', value: 'alpha' },
        { label: 'beta', value: 'beta' },
        { label: 'gamma', value: 'gamma' },
      ],
    })
  })

  it('rejects a chosen value not in the offered options (membership guards the cast)', async () => {
    const { ask } = mockAsk({ mode: 'single', chosen: 'delta' })
    await expect(
      buildAskUserFacade(ask).choose({
        title: 'Pick one',
        options: ['alpha', 'beta', 'gamma'],
      }),
    ).rejects.toThrow(/not one of the offered options/)
  })
})

describe('buildAskUserFacade — form', () => {
  it('passes fields through and unwraps {values} (string|number|boolean)', async () => {
    const { ask, calls } = mockAsk({ values: { name: 'Ada', age: 36, active: true } })
    const values = await buildAskUserFacade(ask).form({
      title: 'Edit',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'age', label: 'Age', type: 'number' },
        { key: 'active', label: 'Active', type: 'boolean' },
      ],
    })
    expect(values).toEqual({ name: 'Ada', age: 36, active: true })
    expect(calls[0]!.kind).toBe('form')
    expect(calls[0]!.payload).toEqual({
      title: 'Edit',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'age', label: 'Age', type: 'number' },
        { key: 'active', label: 'Active', type: 'boolean' },
      ],
    })
  })

  it('rejects values that are not string|number|boolean', async () => {
    const { ask } = mockAsk({ values: { bad: { nested: 1 } } })
    await expect(
      buildAskUserFacade(ask).form({ title: 't', fields: [{ key: 'bad', label: 'B', type: 'text' }] }),
    ).rejects.toThrow()
  })
})

describe('buildAskUserFacade — custom (escape hatch)', () => {
  it('passes opts straight through and returns the raw (schema-parsed) answer', async () => {
    const { ask, calls } = mockAsk('hello')
    const schema = z.string()
    const out = await buildAskUserFacade(ask).custom({
      kind: 'confirm',
      payload: { anything: 1 },
      answerSchema: schema,
    })
    expect(out).toBe('hello')
    expect(calls[0]!.kind).toBe('confirm')
    expect(calls[0]!.payload).toEqual({ anything: 1 })
    expect(calls[0]!.answerSchema).toBe(schema)
  })
})
