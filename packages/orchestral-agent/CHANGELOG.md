# Changelog

All notable changes to `@orchestral/agent` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] - 2026-08-21 — Initial public release

First public release. `@orchestral/agent` is the optional agent extension: one
first-party `AgentPattern` declaration, and nothing else. Agent support is not
part of the core surface — nothing in `@orchestral/core`, `@orchestral/runtime`
or `@orchestral/patterns` depends on this package, so a host that never runs an
LLM loop never installs it.

### Added

- **One first-party `AgentPattern`.** `agent_orchestrator` —
  `createOrchestratorAgent`, the general open-ended media orchestrator. No
  embedded SKILL and no domain workflow: it plans a multi-step media task as it
  goes, over the 18 patterns in `@orchestral/patterns`. It declares three
  per-modality `references` asset slots (`images`, `videos`, `audios`), which
  are the only way a caller hands it assets — it deliberately does not inherit
  the parent's, so a subagent sees exactly what it was given.

  It is a pure declaration — id, zod input schema, prompt, tool list — and
  composes the atomic + meta catalog in `@orchestral/patterns` by pattern id.
  It takes its input through core's `agentInputSchema()` and declares neither
  `outputs` nor `finish`, so the registry backfills core's default finish
  envelope (`{ assets, summary, stepCount }`) and the runtime's finish broker
  injects `complete_task`.

  Exports: `createOrchestratorAgent` / `AGENT_ORCHESTRATOR_PATTERN_ID` /
  `OrchestratorInputSchema` / `OrchestratorInput`.

- **The long-form video director is a reference host, not a published
  pattern.** `agent_long-form-video` — the novel → multi-event director whose
  tool catalog was the narrative chain (`meta_prose-chunking`,
  `meta_novel-to-events`, `meta_event-to-script`, then `meta_script2video` and
  `meta_image-best-of-n`) — lives in `examples/long-form-video` together with
  those metas, registered next to the shipped catalog and covered by the same
  tests it had here. It was one pipeline with one consumer, and every inlined
  prompt on a published surface is a maintenance liability and a PR magnet;
  the example keeps it runnable without making it API. Nothing left in this
  package derives from third-party prompt text — the ViMax-derived
  character-merge prompt moved with the director and is credited in the
  example's own `CREDITS.md`.

- **`"orchestral"` manifest + `orchestral-pattern` keyword.** The package
  declares its agent pattern as `{ id, kind, export }` for
  `registry.addFromManifest(pkg.orchestral, agent)`. No `requiredOps` — the
  agent takes no host operations, so the call needs no ops argument and skips
  nothing.

### What this package deliberately does not ship

- **No tool-loop runner, no agent framework, no provider SDK.** The
  `AgentRunImpl` that drives the LLM tool loop is injected by the host. This is
  the same iron rule as `ModelCapability.call`: the library declares the seam,
  the host fills it. Shipping a loop would mean this package picking an agent
  framework on the host's behalf and dragging its SDK into every install,
  including installs that only want the declarative pattern. A
  copy-pasteable reference implementation over the Vercel AI SDK's
  `ToolLoopAgent` lives in `examples/agent-hello-world/src/agent-runner.ts`
  (~150 lines, with `resolveModel` / `stopWhen` left injected, exercised offline
  against a mock LLM by the example's smoke test) — documentation you copy, not
  a dependency you inherit.

- **The agent machinery itself.** `@orchestral/core` owns `AgentPattern` /
  `agentInputSchema` / the finish envelope, and `@orchestral/runtime` owns
  `dispatchAgent` and the `AgentRunImpl` interface — dormant until a host
  injects a runner. This package supplies Patterns for that machinery to run;
  the host supplies the runner.

### Peer dependencies

- `zod` (`>=4.3 <5`) is a **peer** dependency, for the same reason it is one in
  `@orchestral/patterns`: the schemas here are on the public API, so they must
  be the host's zod instance. Whatever SDK a host's runner uses is the host's
  own install, at the host's chosen version.

### Known limitations

- **The agent does not bound its own spend.** An `AgentPattern` has no
  `ctx.askUser` and no cost gate, and this one declares no `stopWhen` — the
  step-count cap belongs to whoever runs the agent. Cost is not in the finish
  envelope either: the runtime fills `stepCount`, and no per-run accounting
  exists to report. Size the cap against the task rather than a chat turn, and
  enforce any real budget ceiling in the `ModelCapability` your host registers.

- **`@alpha`.** The agent seam is still evolving; `createOrchestratorAgent` is
  marked `@alpha`, and a 0.1 → 0.2 reshape of these exports is not a breaking
  change under the 0.x policy above.
