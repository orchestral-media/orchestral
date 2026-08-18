import { describe, expect, it } from 'vitest'
import { forkExecutionContext } from '../fork-context'
import type { DispatchContext } from '@orchestral/core'

const parent: DispatchContext = {
  signal: new AbortController().signal,
  assets: [{ slot: 'source', assetId: 'a1', modality: 'image' }],
  providerOptions: { fal: { x: 1 } },
  sessionId: 's1',
}

describe('forkExecutionContext', () => {
  it('child assets default to fresh-empty (D7), not inherited', () => {
    expect(forkExecutionContext(parent, {}).assets).toEqual([])
  })
  it('override.assets replaces (resolution output for the child)', () => {
    const child = forkExecutionContext(parent, {
      assets: [{ slot: 'source', assetId: 'b2', modality: 'video' }],
    })
    expect(child.assets).toEqual([{ slot: 'source', assetId: 'b2', modality: 'video' }])
  })
  it('carries sessionId + providerOptions from parent unless overridden', () => {
    const child = forkExecutionContext(parent, {})
    expect(child.sessionId).toBe('s1')
    expect(child.providerOptions).toEqual({ fal: { x: 1 } })
  })
  it('signal falls back to parent, override wins', () => {
    expect(forkExecutionContext(parent, {}).signal).toBe(parent.signal)
    const sig = new AbortController().signal
    expect(forkExecutionContext(parent, { signal: sig }).signal).toBe(sig)
  })
})
