import { describe, it, expect } from 'vitest'
import type { AskUserRequest } from '../pause'

describe('AskUserRequest', () => {
  it('is a plain typed request (no signal class needed in the park model)', () => {
    const req: AskUserRequest<{ title: string }> = {
      id: 'r1', kind: 'confirm', payload: { title: 'ok?' }, sessionId: 's', jobId: 'j',
    }
    expect(req.kind).toBe('confirm')
  })
})
