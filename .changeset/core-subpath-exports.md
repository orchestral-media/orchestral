---
'@orchestral/core': minor
---

**Breaking.** core ships two subpath entries and the root entry no longer
re-exports what they own: `@orchestral/core/memory` (`InMemoryJobStore`,
`InMemoryAssetStore`, `InMemoryTranscriptStore`) and `@orchestral/core/routing`
(`createDefaultCapabilityRouter`, `NoModelForCapabilityError`,
`ModelExcludedError`, `DefaultCapabilityRouterDeps`). Nothing moved between
packages and no signature changed.

The point is that "core is the vocabulary" is now a claim an import list can
contradict. A deprecated alias on the root would have left both spellings
resolvable and kept the sentence unfalsifiable, so there is none: the root entry
is contracts and pure functions, and a host that implements its own `JobStore`
and its own router never names either subpath.

Migration is one line per import: move the symbol out of the
`from '@orchestral/core'` list into `from '@orchestral/core/memory'` or
`from '@orchestral/core/routing'`. The contracts these implement —
`JobStore` / `AssetStore` / `TranscriptStore` / `CapabilityRouter` and their
companion types — stay on the root entry, because that is what a host writing
its own implementation reads.
