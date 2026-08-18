import { describe, expect, it } from 'vitest'
import { resolveExposure } from '@orchestral/core'
import { createTextToImagePattern } from '../atomic/text-to-image'
import { createImageToTextPattern } from '../atomic/image-to-text'
import { createTextToSpeechPattern } from '../atomic/text-to-speech'
import { createImageToImagePattern } from '../atomic/image-to-image'

// SP1 §3.6 — the four launch patterns are canvas-node-able, and switching from
// the 'tool' shorthand to object form must NOT regress their chat exposure.
describe('canvas exposure flips', () => {
  const factories = [
    createTextToImagePattern,
    createImageToTextPattern,
    createTextToSpeechPattern,
    createImageToImagePattern,
  ]
  it.each(factories.map((f) => [f.name, f] as const))('%s exposes canvas + keeps chat/agent', (_n, make) => {
    const resolved = resolveExposure(make().exposure)
    expect(resolved.canvas).toBe(true)
    expect(resolved.chatTurn).toBe(true)
    expect(resolved.agentLoop).toBe(true)
  })
})
