# Changelog

All notable changes to `@orchestral/agent` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [Unreleased]

### Added

- **New package — agent support is now an optional extension.** `@orchestral/agent`
  collects the first-party agent Patterns that used to sit in the catalog, so
  `@orchestral/patterns` is atomic + meta only and nothing in core / runtime /
  patterns depends on this package.

- **Two first-party `AgentPattern`s, moved from `@orchestral/patterns`**
  (unchanged behaviour, new home):
  - `agent_long-form-video` — `createLongFormVideoAgent`, the novel →
    multi-event video director, with the director and character-merge SKILL
    bodies inlined as the cache-stable system prefix.
  - `agent_orchestrator` — `createOrchestratorAgent`, the general open-ended
    media orchestrator, with its per-modality `references` asset slots.

  Their ids, schemas, prompts, and tool catalogs are byte-identical to the ones
  `@orchestral/patterns` 0.1.0 shipped; only the import path changes.

- **`"orchestral"` manifest + `orchestral-pattern` keyword.** The package
  declares its two agent patterns as `{ id, kind, export }` for
  `registry.addFromManifest(pkg.orchestral, agent)`. No `requiredOps` — neither
  agent takes host operations.

### Changed

- **No tool-loop runner ships in this package.** During development this package
  briefly carried `createInProcessAgentRunImpl` (an ai-sdk `ToolLoopAgent`
  wrapper) with `ai` as a peer dependency. It was **never published** — this
  package's first release is the one being prepared here — and it has been
  moved back to `examples/agent-hello-world/src/agent-runner.ts`, where it
  started. There is nothing for a consumer to migrate.

  The reason: `AgentRunImpl` is the same kind of seam as
  `ModelCapability.call` — the library declares it, the host fills it. Shipping
  a loop would have meant this package picking an agent framework on the host's
  behalf and dragging its SDK into every install, including installs that only
  want the two declarative patterns. The runner is still a working reference
  implementation, still exercised by the example's offline smoke test; it is
  just documentation you copy rather than a dependency you inherit.

### Notes

- **No provider SDK, and no agent framework, in the dependency tree.** The only
  peer is `zod` (`>=4.3 <5`), so that the schemas here are the host's zod
  instance. Whatever SDK a host's runner uses is the host's own install.
- **The agent seam itself did not move.** `@orchestral/core` still owns
  `AgentPattern` / `agentInputSchema` / the finish envelope, and
  `@orchestral/runtime` still owns `dispatchAgent` and the `AgentRunImpl`
  interface — dormant until a host injects a runner. This package supplies
  Patterns for that machinery to run; the host supplies the runner.
- **`@alpha`.** The agent seam is still evolving; a 0.1 → 0.2 reshape of these
  exports is not a breaking change under the 0.x policy above.
