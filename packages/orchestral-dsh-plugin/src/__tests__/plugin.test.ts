// Unit tests for the dsh bridge. No LLM, no network, no dsh boot: `ctx` is a
// hand-rolled double implementing exactly the two members `apply` touches
// (`effect` + `tools.register`), which is also the tightest possible statement
// of the dsh surface this plugin depends on.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  silentDiagnosticsLogger,
  PatternRegistry,
  defineAtomicPattern,
  type Job,
  type JobSpec,
  type Pattern,
  type Runtime,
} from '@orchestral/core'
import { createTextToImagePattern } from '@orchestral/patterns'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

import { Config, apply } from '../index'
import { PATTERN_TOOL_OUTPUT_SCHEMA } from '../tool'

// ── doubles ──────────────────────────────────────────────────────────────

interface FakeCtx {
  ctx: Context
  registered: ToolDefinition[]
  disposeAll: () => void
}

function fakeCtx(): FakeCtx {
  const registered: ToolDefinition[] = []
  const effectDisposers: Array<() => void> = []
  const ctx = {
    effect(execute: () => () => void) {
      effectDisposers.push(execute())
      return () => {}
    },
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition)
        return () => {
          const i = registered.indexOf(definition)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
  } as unknown as Context
  return {
    ctx,
    registered,
    disposeAll: () => {
      for (const d of effectDisposers) d()
    },
  }
}

function fakeRuntime(
  output: unknown,
  status: Job['status'] = 'done',
  error: Job['error'] = null,
): Runtime & { specs: JobSpec[] } {
  const specs: JobSpec[] = []
  return {
    specs,
    async submitJob(spec: JobSpec) {
      specs.push(spec)
      return {
        id: 'job_1',
        patternId: spec.patternId,
        idempotencyKey: 'k',
        status,
        input: spec.input,
        output,
        error,
        createdAt: 0,
        updatedAt: 0,
      } as Job
    },
    pollJob: async () => {
      throw new Error('unused')
    },
    cancelJob: async () => {},
    subscribe: () => () => {},
    abandonOrphanedJobs: async () => [],
  } as unknown as Runtime & { specs: JobSpec[] }
}

function runContext(signal = new AbortController().signal): ToolRunContext {
  return { signal } as unknown as ToolRunContext
}

function atomic(
  id: string,
  exposure: Pattern['exposure'],
  extra: Partial<Parameters<typeof defineAtomicPattern>[0]> = {},
) {
  return defineAtomicPattern({
    id,
    description: `${id} pattern`,
    // These tests are about `exposure`; opt every fixture into the first-class
    // tool table so the exposureMode gate below is the only thing a fixture
    // has to say out loud when it wants to test it.
    exposureMode: 'always-load' as const,
    ...(exposure === undefined ? {} : { exposure }),
    primary: {
      tool: {
        description: `call ${id}`,
        inputs: z.object({ prompt: z.string() }),
      },
      modelTags: [],
    },
    outputs: z.object({ ok: z.boolean() }),
    ...extra,
  })
}

/**
 * A minimal AgentPattern. Hand-rolled rather than factory-built: the only
 * thing under test is that the `agent_` prefix routes, and the registry
 * backfills the default finish trio when an agent declares neither `finish`
 * nor `loop.outputExtractor` nor `outputs`.
 */
function agentPattern(id: string, exposure: Pattern['exposure']) {
  return {
    kind: 'agent' as const,
    id,
    description: `${id} pattern`,
    exposureMode: 'always-load' as const,
    ...(exposure === undefined ? {} : { exposure }),
    primary: {
      tool: {
        description: `call ${id}`,
        inputs: z.object({ task: z.string() }),
      },
      modelTags: [],
    },
    loop: {
      system: 'probe',
      toolPatternIds: [],
      modelTags: [],
    },
  }
}

/**
 * `PatternRegistry.register` is generic per Pattern, so a heterogeneous list of
 * concretely-typed Patterns (a `Pattern<TextToImageInput, …>` next to a
 * `Pattern<{prompt:string}, …>`) has no common assignable element type — the
 * `tool.isConcurrencySafe` callbacks are contravariant in the input. Widening
 * at the boundary is the same thing the registry does internally.
 */
function registryOf(...patterns: readonly unknown[]): PatternRegistry {
  const registry = new PatternRegistry({ logger: silentDiagnosticsLogger })
  for (const p of patterns) registry.register(p as Pattern)
  return registry
}

function config(over: Partial<Config> & Pick<Config, 'runtime' | 'registry'>) {
  return Config(over as Config) as Config
}

// ── exposure filtering ───────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers exactly the patterns exposed to the configured surface', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          atomic('visible', 'tool'),
          atomic('subagent-only', 'agent-tool'),
          atomic('host-only', 'no-tool'),
          atomic('defaulted', undefined),
        ),
      }),
    )

    // 'tool' and an undeclared exposure both resolve chatTurn:true;
    // 'agent-tool' and 'no-tool' do not.
    expect(registered.map((t) => t.name)).toEqual(['visible', 'defaulted'])
  })

  it("admits 'agent-tool' patterns on the agentLoop surface", () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          atomic('visible', 'tool'),
          atomic('subagent-only', 'agent-tool'),
          atomic('host-only', 'no-tool'),
        ),
        surface: 'agentLoop',
      }),
    )
    expect(registered.map((t) => t.name)).toEqual(['visible', 'subagent-only'])
  })

  it('honours the per-surface object exposure form, failing closed', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        // chatTurn unset → fails closed, even though other surfaces are open.
        registry: registryOf(
          atomic('slash-only', { slash: true, agentLoop: true }),
        ),
      }),
    )
    expect(registered).toHaveLength(0)
  })

  it('applies the configured tool name prefix', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(atomic('text-to-image', 'tool')),
        toolNamePrefix: 'media_',
      }),
    )
    expect(registered[0]?.name).toBe('media_text-to-image')
  })

  it('projects the pattern zod input schema into ToolSchema.parameters', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(atomic('p', 'tool')),
      }),
    )
    const params = registered[0]?.parameters as Record<string, unknown>
    expect(params.type).toBe('object')
    expect(params.properties).toHaveProperty('prompt')
    expect(params.required).toEqual(['prompt'])
    expect(registered[0]?.description).toBe('call p')
  })

  it('unwinds every registration when the owning effect disposes', () => {
    const { ctx, registered, disposeAll } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(atomic('a', 'tool'), atomic('b', 'tool')),
      }),
    )
    expect(registered).toHaveLength(2)
    disposeAll()
    expect(registered).toHaveLength(0)
  })

  it('exposes a real first-party pattern', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(createTextToImagePattern()),
      }),
    )
    expect(registered.map((t) => t.name)).toEqual(['text-to-image'])
    expect(registered[0]?.description).toMatch(/image from a text prompt/i)
  })

  it('applies the sub-agent blocklist on the agentLoop surface', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          atomic('visible', 'tool'),
          agentPattern('agent_probe', { chatTurn: true, agentLoop: true }),
        ),
        surface: 'agentLoop',
      }),
    )

    // orchestral's own agentLoop catalog is exposure AND the recursion guard
    // (catalog.ts calls the `agent_` prefix match "a normative contract, not a
    // coincidence of naming"). Running only the first gate here would make the
    // bridge strictly more permissive than the surface it claims to mirror.
    expect(registered.map((t) => t.name)).toEqual(['visible'])
  })

  it('leaves an agent pattern reachable on the chatTurn surface', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          agentPattern('agent_probe', { chatTurn: true, agentLoop: true }),
        ),
      }),
    )

    // The blocklist is a SUB-AGENT guard, not a global ban: a top-level turn
    // delegating to an agent is exactly what `agent_*` exists for.
    expect(registered.map((t) => t.name)).toEqual(['agent_probe'])
  })

  it('registers only always-load patterns by default', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          atomic('always', 'tool'),
          atomic('deferred-atomic', 'tool', { exposureMode: 'deferred' }),
        ),
      }),
    )

    // `exposureMode` is orthogonal to `exposure`: 'deferred' (the default)
    // means "reachable only through find_pattern → dispatch_pattern". A bridge
    // that promotes the whole registry to first-class tools forces every
    // Pattern to always-load — the exact failure the field exists to prevent.
    expect(registered.map((t) => t.name)).toEqual(['always'])
  })

  it('registers deferred patterns when the host asks for the flat catalog', () => {
    const { ctx, registered } = fakeCtx()
    apply(
      ctx,
      config({
        runtime: fakeRuntime(null),
        registry: registryOf(
          atomic('always', 'tool'),
          atomic('deferred-atomic', 'tool', { exposureMode: 'deferred' }),
        ),
        exposeDeferred: true,
      }),
    )
    expect(registered.map((t) => t.name)).toEqual(['always', 'deferred-atomic'])
  })
})

// ── the output contract dsh enforces at registration ─────────────────────

describe('output schema', () => {
  it('sits inside the JSON Schema subset dsh accepts', () => {
    expect(() =>
      assertSupportedJsonSchema(PATTERN_TOOL_OUTPUT_SCHEMA),
    ).not.toThrow()
  })
})

// ── dispatch ─────────────────────────────────────────────────────────────

describe('tool execution', () => {
  it('submits a job carrying the model arguments verbatim', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({ ok: true })
    apply(
      ctx,
      config({ runtime, registry: registryOf(atomic('p', 'tool')) }),
    )

    const result = await registered[0]!.execute(
      { prompt: 'a cat' },
      runContext(),
    )

    expect(runtime.specs).toEqual([
      { patternId: 'p', input: { prompt: 'a cat' } },
    ])
    expect(result).toEqual({
      jobId: 'job_1',
      patternId: 'p',
      status: 'done',
      output: { ok: true },
    })
  })

  it('threads host session / asset-context routing into the JobSpec', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({ ok: true })
    apply(
      ctx,
      config({
        runtime,
        registry: registryOf(atomic('p', 'tool')),
        resolveJobContext: () => ({
          sessionId: 's1',
          assetContextId: 'run_7',
        }),
      }),
    )

    await registered[0]!.execute({ prompt: 'x' }, runContext())
    expect(runtime.specs[0]).toMatchObject({
      sessionId: 's1',
      assetContextId: 'run_7',
    })
  })

  it('projects produced assets so no assetId reaches the model', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({
      assets: [
        {
          handle: 'image_1',
          assetId: 'ast_SECRET',
          url: 'https://provider.example/signed/SECRET',
          modality: 'image',
          label: 'hero',
          origin: 'generated',
        },
      ],
      cost: 0.02,
    })
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    const result = (await registered[0]!.execute(
      { prompt: 'x' },
      runContext(),
    )) as { output: { assets: Array<Record<string, unknown>> } }

    expect(result.output.assets[0]).toEqual({
      handle: 'image_1',
      uri: 'asset://image_1',
      modality: 'image',
      label: 'hero',
      origin: 'generated',
    })
    // The verifiable assertion: the serialized result cannot leak either.
    const wire = JSON.stringify(result)
    expect(wire).not.toContain('ast_SECRET')
    expect(wire).not.toContain('provider.example')
  })

  it('scrubs binary that a pattern accidentally put in its output', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({
      caption: 'a cat',
      thumbnail: `data:image/png;base64,${'A'.repeat(64)}`,
    })
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    const result = (await registered[0]!.execute(
      { prompt: 'x' },
      runContext(),
    )) as { output: { caption: string; thumbnail: string } }

    expect(result.output.caption).toBe('a cat')
    expect(result.output.thumbnail).not.toContain('data:image/png')
    expect(result.output.thumbnail).toContain('binary stripped')
  })

  it('omits output for a non-terminal dedup hit', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime(null, 'running')
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    const result = await registered[0]!.execute({ prompt: 'x' }, runContext())
    expect(result).toEqual({
      jobId: 'job_1',
      patternId: 'p',
      status: 'running',
    })
  })

  it('raises a failed dispatch as a tool error carrying the JobError code and message', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime(null, 'error', {
      code: 'PROVIDER_FAILED',
      message: 'provider 500',
    })
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    // orchestral returns the failure as data; dsh's only channel for a failed
    // call is a throw, so the JobError is re-raised in its `CODE: message` form.
    await expect(
      registered[0]!.execute({ prompt: 'x' }, runContext()),
    ).rejects.toThrow(/^PROVIDER_FAILED: provider 500$/)
  })

  it('does not repeat the code when the JobError message already leads with it', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime(null, 'error', {
      code: 'PERMISSION_DENIED',
      message: 'PERMISSION_DENIED: over quota',
    })
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    await expect(
      registered[0]!.execute({ prompt: 'x' }, runContext()),
    ).rejects.toThrow(/^PERMISSION_DENIED: over quota$/)
  })

  it('raises a cancelled dispatch as a CANCELLED tool error', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime(null, 'cancelled')
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    await expect(
      registered[0]!.execute({ prompt: 'x' }, runContext()),
    ).rejects.toThrow(/^CANCELLED: dispatch of p was cancelled/)
  })

  it('refuses to dispatch a call the caller already aborted', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({ ok: true })
    apply(ctx, config({ runtime, registry: registryOf(atomic('p', 'tool')) }))

    const controller = new AbortController()
    controller.abort()
    await expect(
      registered[0]!.execute({ prompt: 'x' }, runContext(controller.signal)),
    ).rejects.toThrow()
    expect(runtime.specs).toHaveLength(0)
  })

  it('fails closed when a required asset slot cannot be resolved', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({ ok: true })
    const submit = vi.spyOn(runtime, 'submitJob')
    apply(
      ctx,
      config({
        runtime,
        registry: registryOf(
          atomic('edit', 'tool', {
            assetNeeds: [
              {
                slot: 'source',
                modality: 'image',
                cardinality: 'single',
                required: true,
              },
            ],
          }),
        ),
      }),
    )

    // Empty ledger + a required slot → the resolution pass fails closed and
    // the model is told, instead of a dispatch running without its attachment.
    await expect(
      registered[0]!.execute({ prompt: 'x' }, runContext()),
    ).rejects.toThrow(/ASSET_RESOLUTION_FAILED.*edit/)
    expect(submit).not.toHaveBeenCalled()
  })

  it('resolves a handle from the host ledger into JobSpec.assets', async () => {
    const { ctx, registered } = fakeCtx()
    const runtime = fakeRuntime({ ok: true })
    apply(
      ctx,
      config({
        runtime,
        registry: registryOf(
          atomic('edit', 'tool', {
            assetNeeds: [
              {
                slot: 'source',
                modality: 'image',
                cardinality: 'single',
                required: true,
              },
            ],
          }),
        ),
        resolveJobContext: () => ({
          assetEvents: [
            {
              kind: 'asset',
              orderHint: 1,
              annotation: { assetId: 'ast_1', modality: 'image' },
            },
          ],
        }),
      }),
    )

    await registered[0]!.execute(
      { prompt: 'x', references: { source: 'image_1' } },
      runContext(),
    )
    expect(runtime.specs[0]?.assets).toEqual([
      { slot: 'source', assetId: 'ast_1', handle: 'image_1', modality: 'image' },
    ])
  })
})
