// @orchestral/core/routing — the default capability router.
//
// The `CapabilityRouter` interface stays on the root barrel: it is vocabulary,
// and a host implementing its own router needs it. The (capability, tags, ctx)
// → model algorithm behind `createDefaultCapabilityRouter` is one answer to
// that interface, not the interface, and it is the single largest body of
// policy in the package — so it answers from here instead.
//
// The two errors travel with it because they are what the algorithm throws; a
// host that catches them has necessarily called into this entry.

export {
  createDefaultCapabilityRouter,
  NoModelForCapabilityError,
  ModelExcludedError,
  type DefaultCapabilityRouterDeps,
} from './capability-router-default'
