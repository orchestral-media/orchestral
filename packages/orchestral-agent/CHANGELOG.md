# Changelog

All notable changes to `@orchestral/agent` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **0.x note:** while the API is pre-1.0, minor releases may contain breaking
> changes. Pin `"~0.1"` for patch-only updates. Breaking changes are listed under
> `### Breaking (0.x)`.

## [0.1.0] — Initial public release

First public release. `@orchestral/agent` is the optional agent extension: two
first-party `AgentPattern` declarations, and nothing else. Agent support is not
part of the core surface — nothing in `@orchestral/core`, `@orchestral/runtime`
or `@orchestral/patterns` depends on this package, so a host that never runs an
LLM loop never installs it.

### Added

- **Two first-party `AgentPattern`s.**
  - `agent_long-form-video` — `createLongFormVideoAgent`, the novel →
    multi-event video director. The director and character-merge SKILL bodies
    are inlined as string constants and baked into `loop.system` at factory
    time, forming a cache-stable system prefix; the per-dispatch extras
    (`style`, `maxEvents`) are appended after it. Its tool catalog is the
    narrative chain — `meta_prose-chunking`, `meta_novel-to-events`,
    `meta_event-to-script`, `meta_script2video`, `meta_image-best-of-n`, and
    `text-generation`.
  - `agent_orchestrator` — `createOrchestratorAgent`, the general open-ended
    media orchestrator. No embedded SKILL and no domain workflow: it plans a
    multi-step media task as it goes, over all 25 patterns in
    `@orchestral/patterns`. It declares three per-modality `references` asset
    slots (`images`, `videos`, `audios`), which are the only way a caller hands
    it assets — it deliberately does not inherit the parent's, so a subagent
    sees exactly what it was given.

  Both are pure declarations — ids, zod input schemas, prompts, tool lists — and
  both compose the atomic + meta catalog in `@orchestral/patterns` by pattern
  id. Both take their input through core's `agentInputSchema()`, and neither
  declares `outputs` or `finish`, so the registry backfills core's default
  finish envelope (`{ assets, summary, stepCount }`) and the runtime's finish
  broker injects `complete_task`.

  Exports: `createLongFormVideoAgent` / `AGENT_LONG_FORM_VIDEO_PATTERN_ID` /
  `AgentLongFormVideoInputSchema` / `AgentLongFormVideoInput`, and
  `createOrchestratorAgent` / `AGENT_ORCHESTRATOR_PATTERN_ID` /
  `OrchestratorInputSchema` / `OrchestratorInput`.

- **`"orchestral"` manifest + `orchestral-pattern` keyword.** The package
  declares its two agent patterns as `{ id, kind, export }` for
  `registry.addFromManifest(pkg.orchestral, agent)`. No `requiredOps` — neither
  agent takes host operations, so the call needs no ops argument and skips
  nothing.

- **`CREDITS.md`** records the provenance of the one prompt constant derived
  from HKUDS/ViMax (MIT) — `CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT` — and
  reproduces the MIT license text in full. The file ships inside the published
  tarball. `LONG_FORM_VIDEO_DIRECTOR_PROMPT` and `ORCHESTRATOR_SYSTEM_PROMPT`
  are not derived from it.

### What this package deliberately does not ship

- **No tool-loop runner, no agent framework, no provider SDK.** The
  `AgentRunImpl` that drives the LLM tool loop is injected by the host. This is
  the same iron rule as `ModelCapability.call`: the library declares the seam,
  the host fills it. Shipping a loop would mean this package picking an agent
  framework on the host's behalf and dragging its SDK into every install,
  including installs that only want the two declarative patterns. A
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

- **Neither agent bounds its own spend.** An `AgentPattern` has no `ctx.askUser`
  and no cost gate, and neither of these two declares a `stopWhen` — the
  step-count cap belongs to whoever runs the agent. Cost is not in the finish
  envelope either: the runtime fills `stepCount`, and no per-run accounting
  exists to report. Size the cap against the pattern's own input bound rather
  than a chat turn (`agent_long-form-video` costs roughly `maxEvents` × ~7
  iterations plus ~10 for framing, so at the schema's `maxEvents` cap of 500 a
  complete run is ~3500 steps), and enforce any real budget ceiling in the
  `ModelCapability` your host registers.

- **`@alpha`.** The agent seam is still evolving; `createLongFormVideoAgent` and
  `createOrchestratorAgent` are marked `@alpha`, and a 0.1 → 0.2 reshape of
  these exports is not a breaking change under the 0.x policy above.
