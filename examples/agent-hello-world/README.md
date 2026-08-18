# agent-hello-world

A from-scratch host that runs one **agent-kind** dispatch through the
`@orchestral/*` packages. The agent's LLM loop decides to call the
`text-to-image` tool, reads the produced image, and reports a one-line summary.
The entire host is the wiring in [`src/main.ts`](./src/main.ts) plus one OpenAI
API key — there is **zero host engine code**: no worker, no IPC, no database.

This is the agent-battery companion to
[`../atomic-hello-world`](../atomic-hello-world). The new piece is
`createInProcessAgentRunImpl`, a host-local in-process `AgentRunImpl` (in
[`src/agent-runner.ts`](./src/agent-runner.ts)) that drives the ai-sdk
`ToolLoopAgent` (this example pins `ai@^7`) and bridges its tool calls back
into the runtime. Like the
`call` adapter, driving the LLM loop is host territory — the @orchestral
packages ship no provider runner.

> **`@alpha`.** The agent seam (`AgentRunImpl`) is still evolving; a 0.1 → 0.2
> reshape of this export is not a breaking change.

## Run it

```sh
export OPENAI_API_KEY=sk-...
pnpm install
pnpm --filter agent-hello-world start
```

It dispatches an image brief, runs the LLM tool-loop to completion (synchronous
in this process), and logs the agent's summary plus the produced image URI.

> **`submitJob` rejects on terminal failure.** The runtime marks the job row
> `errored` and rethrows, so in a real host the failure path is a `try` /
> `catch` around the `await` — that is the branch you will actually hit. The
> `job.status !== 'done'` guard in `main.ts` covers the one case that does *not*
> throw: an idempotency-dedup hit hands back an existing row, which may still be
> in flight.

## No key? Run the smoke test

```sh
pnpm --filter agent-hello-world test
```

[`src/__tests__/wiring.smoke.test.ts`](./src/__tests__/wiring.smoke.test.ts)
runs the **same** registry → router → runtime → `submitJob` path, but the LLM is
a scripted `MockLanguageModelV3` (`ai/test`) and the image model is a
`MockImageModelV3` — so the whole agent loop runs offline with no key. The mock
LLM scripts a two-step loop (step 1 emits a `text-to-image` tool call, step 2
emits the final JSON answer), and the test asserts the job reaches `done`, the
output parses against the agent pattern's schema, and the tool call actually
recursed through `onToolCall` into the runtime. It also runs as part of the
repo's `pnpm test:run`.

## What's host territory vs. what ships in the box

- **`JobStore` and `CapabilityRouter`** use the zero-dependency defaults
  (`InMemoryJobStore`, `createDefaultCapabilityRouter`). Nothing to implement.
- **The tool's `ModelCapability.call`** (text-to-image) is bridged by the
  host-local [`src/ai-sdk-wiring.ts`](./src/ai-sdk-wiring.ts), exactly as in the
  atomic example.
- **The agent loop** is driven by `createInProcessAgentRunImpl` (host-local, in
  [`src/agent-runner.ts`](./src/agent-runner.ts)). Its only host-shaped seam is
  `resolveModel`: map the loop's `modelTags` to a concrete ai-sdk LLM instance
  you built with your own key (BYOK territory). An optional `stopWhen` callback
  overrides the default 16-step cap. Everything else — tool wrapping, the
  `onToolCall` bridge back into the runtime, `system` → `instructions`,
  abort/timeout plumbing — is host-agnostic boilerplate you copy once.
- **Typed output.** The agent pattern declares `loop.outputExtractor`, which
  tells the runtime to skip injecting its default finish tool for this
  dispatch; the in-process runner then returns the natural-finish `{ text }`
  fallback, and `outputExtractor` lifts typed deliverables from the LLM's
  final text (the runtime then validates them against `outputs`). See
  [`src/pattern.ts`](./src/pattern.ts).

A production host (a desktop app, a server) swaps `createInProcessAgentRunImpl`
for its own `AgentRunImpl` that runs the loop in a worker over IPC, persists the
message history, and grants host tools — the same `InlineRuntime` construction,
a different injected runner.
