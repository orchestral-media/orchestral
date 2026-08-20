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
  collects everything agent-specific that used to be spread across the catalog
  and the examples, so `@orchestral/patterns` is atomic + meta only and nothing
  in core / runtime / patterns depends on this package.

- **Two first-party `AgentPattern`s, moved from `@orchestral/patterns`**
  (unchanged behaviour, new home):
  - `agent_long-form-video` — `createLongFormVideoAgent`, the novel →
    multi-event video director, with the director and character-merge SKILL
    bodies inlined as the cache-stable system prefix.
  - `agent_orchestrator` — `createOrchestratorAgent`, the general open-ended
    media orchestrator, with its per-modality `references` asset slots.

  Their ids, schemas, prompts, and tool catalogs are byte-identical to the ones
  `@orchestral/patterns` 0.1.0 shipped; only the import path changes.

- **`createInProcessAgentRunImpl`, promoted from `examples/agent-hello-world`.**
  The reference `AgentRunImpl` over the ai-sdk `ToolLoopAgent`: it wraps each
  runtime tool descriptor, bridges `execute` back into the runtime through
  `onToolCall`, maps `system` → `instructions`, and threads abort/timeout into
  `generate()`. The host-shaped seams (`resolveModel`, `stopWhen`) stay
  injected. Every host that wanted an in-process loop was copying this file;
  now it is a dependency.

- **`"orchestral"` manifest + `orchestral-pattern` keyword.** The package
  declares its two agent patterns as `{ id, kind, export }` for
  `registry.addFromManifest(pkg.orchestral, agent)`. No `requiredOps` — neither
  agent takes host operations.

### Notes

- **`ai` is a peer dependency (`^7`), not a bundled one.** Orchestral ships no
  provider SDK: the host's model instance and the loop that consumes it must
  come from the same copy of `ai`, and the host owns the SDK version and its
  credentials. `zod` (`>=4.3 <5`) is a peer for the same reason.
- **The agent seam itself did not move.** `@orchestral/core` still owns
  `AgentPattern` / `agentInputSchema` / the finish envelope, and
  `@orchestral/runtime` still owns `dispatchAgent` and the `AgentRunImpl`
  interface — dormant until a host injects a runner. This package only fills
  that seam.
- **`@alpha`.** The agent seam is still evolving; a 0.1 → 0.2 reshape of these
  exports is not a breaking change under the 0.x policy above.
