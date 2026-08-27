// @orchestral/dsh-plugin — supply orchestral's media-generation Patterns to a
// DeepSeek Harness agent as ordinary dsh tools.
//
// Architecture constraint (hard, see README): this is a LEAF package. It
// depends on @orchestral/core + @orchestral/runtime and on dsh; nothing in
// orchestral depends on it. dsh is a developer preview with promised
// compatibility-breaking changes — when the bridge breaks, only the bridge is
// repaired, and @orchestral/core|runtime|patterns never learn dsh exists.
//
// Cordis function-plugin form (`name` / `inject` / `Config` / `apply`).
// `inject: ['tools']` makes Cordis wait for the tool registry to exist before
// `apply` runs.
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PatternRegistry, Runtime } from '@orchestral/core'

import { buildPatternToolDescriptors, type ExposureSurface } from './expose'
import { buildPatternTool, type JobContext } from './tool'

export const name = 'orchestral'

export const inject = ['tools']

export interface Config {
  /**
   * A CONSTRUCTED orchestral Runtime (the reference implementation is
   * `InlineRuntime` from @orchestral/runtime).
   *
   * The plugin never builds one. A Runtime needs a JobStore, a
   * CapabilityRouter, provider credentials, and a `resolveCtxProvider` — all
   * host-owned deployment decisions that a plugin has no business guessing.
   * Pass a live instance through a `!!js` config expression (see README).
   */
  runtime: Runtime
  /** The PatternRegistry whose exposed Patterns become tools. */
  registry: PatternRegistry
  /**
   * Which orchestral exposure surface this dsh tool registry represents.
   * Default `'chatTurn'` — the conservative reading, admitting only Patterns
   * an author marked visible to a top-level turn.
   */
  surface: ExposureSurface
  /**
   * Prefix for every registered tool name. Empty by default: PatternIds are
   * already valid LLM tool names by design. Set one when the profile mounts
   * other plugins that might coin the same name.
   */
  toolNamePrefix: string
  /**
   * Register EVERY exposed Pattern as a first-class dsh tool, including the
   * ones whose author left `exposureMode` at its `'deferred'` default.
   * `false` by default, and the default is the load-bearing half.
   *
   * `exposureMode` is orthogonal to `exposure`: `'always-load'` means "worth a
   * permanent slot in the LLM's tool table, callable in one hop",
   * `'deferred'` means "discoverable through find_pattern, dispatched through
   * dispatch_pattern". Pattern authors are told to promote high-frequency
   * generation atomics and explicitly NOT to promote understanding atomics
   * (`image-to-text` / `text-generation`), because promoting those "only
   * encourages offloading the task to a weaker sub-tool"
   * (@orchestral/core `PatternBase.exposureMode`).
   *
   * Turning this on hands the model the whole register at once. The cost is
   * paid twice: every descriptor sits in the cached tool prefix for the
   * agent's whole lifetime, and selection interference grows with the count.
   * It also skips what the two-hop path adds — find_pattern lifts the top-1
   * model's `providerOptions` into the schema and derives a per-match
   * description, so a Pattern promoted here is exposed with its BASE input
   * schema. Set it when the profile mounts a small curated registry and no
   * find_pattern bridge exists.
   */
  exposeDeferred: boolean
  /** Per-tool-call deadline in ms, enforced by dsh's timeout policy. Omit for none. */
  timeoutMs?: number
  /**
   * Per-call session / asset-ledger routing. Called with the model's raw
   * arguments; returns the JobSpec routing metadata for that call. Omit when
   * the host has no asset ledger — Patterns with no `assetNeeds` never need it.
   */
  resolveJobContext?: (args: unknown) => JobContext
}

/**
 * Schemastery schema (Cordis validates config through Standard Schema and
 * fills defaults from it). `runtime` / `registry` / `resolveJobContext` are
 * live host objects arriving through `!!js` expressions, so they are declared
 * `any` — there is no serializable schema for a class instance, and
 * Schemastery passes such values through by identity.
 */
export const Config: Schema<Config> = Schema.object({
  runtime: Schema.any().required(),
  registry: Schema.any().required(),
  surface: Schema.union(['chatTurn', 'agentLoop'] as const).default('chatTurn'),
  toolNamePrefix: Schema.string().default(''),
  exposeDeferred: Schema.boolean().default(false),
  timeoutMs: Schema.number(),
  resolveJobContext: Schema.any(),
}) as Schema<Config>

export function apply(ctx: Context, config: Config): void {
  const patterns = [...config.registry.values()]
  const byId = new Map(patterns.map((p) => [p.id as string, p]))
  const descriptors = buildPatternToolDescriptors(patterns, {
    surface: config.surface,
    toolNamePrefix: config.toolNamePrefix,
    exposeDeferred: config.exposeDeferred,
  })

  // One effect owning every registration, so an unload / HMR reload unwinds
  // them together and in reverse order. `ctx.tools.register` already returns
  // its exact disposer; the enclosing effect just keeps the group atomic.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    for (const descriptor of descriptors) {
      const pattern = byId.get(descriptor.patternId)
      /* c8 ignore next -- descriptors are derived from this same list */
      if (!pattern) continue
      disposers.push(
        ctx.tools.register(
          buildPatternTool({
            runtime: config.runtime,
            pattern,
            descriptor,
            ...(config.timeoutMs === undefined
              ? {}
              : { timeoutMs: config.timeoutMs }),
            ...(config.resolveJobContext === undefined
              ? {}
              : { resolveJobContext: config.resolveJobContext }),
          }),
        ),
      )
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, '@orchestral/dsh-plugin: pattern tools')
}

export {
  buildPatternToolDescriptors,
  type ExposureSurface,
  type PatternToolDescriptor,
} from './expose'
export {
  buildPatternTool,
  PATTERN_TOOL_OUTPUT_SCHEMA,
  type BuildToolOptions,
  type JobContext,
  type PatternToolResult,
} from './tool'
