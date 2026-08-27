// @orchestral/core/memory — the in-memory stores, on their own entry.
//
// Why a subpath and not a package: the dependency direction is already right
// (these implement contracts that live beside them, they import nothing new),
// so splitting a package would buy nothing but a version line to keep in sync.
// What was missing is falsifiability — with a single `.` entry, "core is the
// vocabulary" was a sentence no import statement could contradict. A host that
// brings its own JobStore now simply never names this entry.
//
// The contracts stay on the root barrel and only the implementations move:
// `JobStore`, `AssetStore`, `TranscriptStore` are what a host writes against,
// and a host writing its own has no reason to load these three.
//
// Dev-and-test by intent: nothing here survives a process restart, and none of
// it is the durable store a production host owes the Runtime.

export { InMemoryJobStore } from './job-store-memory'
export { InMemoryAssetStore } from './asset-store'
export { InMemoryTranscriptStore } from './transcript-store'
