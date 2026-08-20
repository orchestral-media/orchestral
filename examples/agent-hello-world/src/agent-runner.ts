// Host-local AgentRunImpl — the in-process ai-sdk tool-loop. This is the
// agent-side analogue of the atomic example's ai-sdk-wiring.ts, and it lives
// here for the same reason that file does: the @orchestral packages ship no
// provider SDK and no agent framework, so picking one (here: the Vercel AI
// SDK's ToolLoopAgent) is the host's call, not the library's. That is the same
// iron rule that leaves `ModelCapability.call` unimplemented in the box —
// @orchestral/agent defines the two AgentPatterns, @orchestral/runtime defines
// the AgentRunImpl seam, and this file is what a host writes to fill it.
//
// The runtime calls `run()` once per AgentPattern dispatch. Everything
// host-agnostic — wrapping each tool, the onToolCall bridge back into the
// runtime, system → instructions, abort/timeout plumbing — lives here, and is
// portable across hosts: copy this file, keep the two genuinely host-shaped
// seams (resolving model tags to a concrete LanguageModel, and the loop stop
// condition) as the deps you fill in. main.ts fills them in directly.
//
// A production host (worker over IPC, persisted message history, host-granted
// tools) writes its own AgentRunImpl instead; the seam is the same either way.

import {
  jsonSchema,
  stepCountIs,
  tool,
  ToolLoopAgent,
  type ModelMessage,
  type StopCondition,
  type Tool,
  type ToolSet,
} from 'ai'
import type { AgentRunImpl, AgentToolDescriptor } from '@orchestral/runtime'
import type { ModelTag, ResolveContext } from '@orchestral/core'

// The resolved language-model type a host returns from `resolveModel`. Pulled
// out of ToolLoopAgent's own constructor settings instead of importing
// LanguageModelV3 from @ai-sdk/provider (which `ai` does not re-export). A host
// builds the instance with its BYOK key (e.g. `openai('gpt-4o')`).
export type LanguageModelInstance = ConstructorParameters<
  typeof ToolLoopAgent
>[0]['model']

export interface AgentRunDeps {
  /** Resolve the loop's model. BYOK territory: map `modelTags` to a concrete
   * ai-sdk LanguageModel instance. May be async (key load / provider init). */
  resolveModel: (args: {
    modelTags: readonly ModelTag[]
    resolveCtx?: ResolveContext
    sessionId?: string
  }) => LanguageModelInstance | Promise<LanguageModelInstance>

  /** Loop stop condition. Defaults to `stepCountIs(16)`. */
  stopWhen?: (args: {
    patternId: string
  }) => StopCondition<ToolSet> | StopCondition<ToolSet>[]
}

const DEFAULT_STOP_STEPS = 16

/**
 * Build an in-process `AgentRunImpl` backed by the ai-sdk's `ToolLoopAgent`.
 * Pass the result to `new InlineRuntime({ agentRunImpl })` to run AgentPatterns
 * entirely in this process — no worker, no IPC, no DB.
 *
 * Per dispatch, `run()` resolves the model, wraps each `AgentToolDescriptor`
 * into an ai-sdk Tool whose `execute` forwards to `args.onToolCall` (which
 * recurses into runtime.submitJob), maps `args.system` → ToolLoopAgent
 * `instructions`, threads abort/timeout into `generate()`, and returns the
 * natural-finish `{ text }` fallback. An AgentPattern that needs typed
 * deliverables declares `loop.outputExtractor` to lift them from the final text.
 */
export function createInProcessAgentRunImpl(deps: AgentRunDeps): AgentRunImpl {
  return {
    async run(args) {
      const model = await deps.resolveModel({
        modelTags: args.modelTags,
        ...(args.resolveCtx ? { resolveCtx: args.resolveCtx } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      })

      // Already-aborted parent dispatch — bail before spending a model call.
      if (args.abortSignal.aborted) {
        throw new DOMException('aborted', 'AbortError')
      }

      // Wrap each runtime tool descriptor into an ai-sdk Tool. The execute
      // closure round-trips into runtime via onToolCall and returns its
      // result/error object as the tool output. The runtime already maps
      // failures to structured tool_result content, so forward verbatim — the
      // LLM reads it and self-corrects on the next step.
      const aiSdkTools: Record<string, Tool> = Object.fromEntries(
        args.tools.map((descriptor: AgentToolDescriptor) => [
          descriptor.name,
          tool({
            description: descriptor.description,
            // Descriptor inputSchema is a JSON Schema (built by the runtime's
            // catalog builder); ai-sdk's jsonSchema() wraps it without
            // client-side validation — runtime is the source of truth.
            inputSchema: jsonSchema(
              descriptor.inputSchema as Parameters<typeof jsonSchema>[0],
            ),
            execute: (input: unknown, { toolCallId }: { toolCallId: string }) =>
              args.onToolCall({
                name: descriptor.name,
                input,
                callId: toolCallId,
              }),
          }),
        ]),
      )

      const stopWhen = deps.stopWhen
        ? deps.stopWhen({ patternId: args.patternId })
        : stepCountIs(DEFAULT_STOP_STEPS)

      const agent = new ToolLoopAgent({
        model,
        // ai-sdk ToolLoopAgent's constructor field for the system prompt is
        // `instructions` (orchestral uses `system`).
        instructions: args.system,
        tools: aiSdkTools,
        stopWhen,
      })

      const result = await agent.generate({
        // The protocol ships messages as opaque AgentChatMessage[]; ai-sdk's
        // `messages` expects ModelMessage[]. dispatchAgent always passes a
        // structurally-compatible seed (role + content), so cast at this seam.
        messages: args.messages as ModelMessage[],
        abortSignal: args.abortSignal,
        ...(args.timeout ? { timeout: args.timeout } : {}),
        onStepFinish: (step) => {
          args.onStepFinish?.({
            stepIndex: step.stepNumber,
            toolCalls: (step.toolCalls ?? []).map((call) => ({
              name: call.toolName,
              input: call.input,
            })),
            text: step.text ?? '',
            ...(step.usage?.totalTokens !== undefined
              ? { usage: { totalTokens: step.usage.totalTokens } }
              : {}),
          })
        },
      })

      const totalTokens = result.totalUsage?.totalTokens
      return {
        // AgentRunImpl.run() only returns the final text (+ usage); the
        // runtime's dispatchAgent composes structured outputs itself, either
        // via the runtime-injected finish tool or (as here) an
        // AgentPattern's loop.outputExtractor lifting typed deliverables
        // from this text.
        text: result.text,
        ...(totalTokens !== undefined ? { usage: { totalTokens } } : {}),
      }
    },
  }
}
