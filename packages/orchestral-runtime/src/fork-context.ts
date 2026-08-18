// forkExecutionContext — the single factory all child dispatch derives its
// DispatchContext from. Centralizes the inheritance policy so the "what does a
// child see" decision lives in one tested place instead of inline object
// literals scattered across dispatchAtomic / dispatchAgent.
//
// Policy:
//   • assets   — DEFAULT FRESH (`[]`). A child never inherits the parent's
//     resolved assets implicitly; it gets exactly what the host resolved for
//     this dispatch (override.assets) or nothing. Opt-in inheritance is handled
//     one level up by re-announcing into the child's seed, not here.
//   • signal   — inherits the parent's unless overridden (abort cascade).
//   • sessionId / providerOptions / project — ambient, inherited unless overridden.

import type { DispatchContext } from '@orchestral/core'

/** @alpha */
export function forkExecutionContext<P = unknown>(
  parent: DispatchContext<P>,
  overrides: Partial<DispatchContext<P>>,
): DispatchContext<P> {
  return {
    ...parent,
    ...overrides,
    signal: overrides.signal ?? parent.signal,
    assets: overrides.assets ?? [],
  }
}
