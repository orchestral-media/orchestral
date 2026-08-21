// 三层嵌套 meta 的 step-cache 命名空间隔离 — 运行时回归 (ADR-009 §A.5)。
//
// meta-nested-stepid-namespace.test.ts 锁的是 parent → child 两层:同一 child
// meta 跑两遍时,固定显式 stepId 不互撞、stepCache 不交叉污染。本文件把它推到
// 第三层(grandchild),因为命名空间前缀是「递归」拼的 —— 子 meta 把自己 step
// 的 effectiveStepId 当成孙 meta 的 stepIdNamespace(dispatchMeta 把
// spec.stepIdNamespace 传进 buildMetaExecutionContext,ctx.step 再把
// effectiveStepId 盖到子 spec 上)。如果前缀只生效一层,sibling child 下的孙 step 会
// 在祖父级共享 stepCache 里互相命中,产生静默 cross-contamination。
//
// 结构:meta_parent --[child-0, child-1]--> meta_child --[gc-0, gc-1]-->
//       meta_grandchild --[gc-step]--> fake-image
// 共 2×2×1 = 4 次 image 调用,每次 prompt 唯一、assetId 唯一。命名空间断在任意
// 一层都会让后续孙 step 短路命中前一个的缓存 → 调用数 < 4。

import { describe, expect, it } from 'vitest'

import type {
  AtomicPattern,
  CapabilityRouter,
  MetaPattern,
  ModelCapability,
} from '@orchestral/core'
import { InMemoryJobStore as MemoryJobStore, PatternRegistry } from '@orchestral/core'
import { z } from 'zod'

import { InlineRuntime } from '../inline'

// Fake atomic "image" capability — each call returns a UNIQUE id so a cache hit
// (cross-contamination) is observable: a reused cached result keeps the serial
// from advancing.
function makeImageRouter(calls: Array<{ prompt: string }>): CapabilityRouter {
  let serial = 0
  const cap: ModelCapability = {
    modelId: 'fake:img',
    provider: 'fake',
    tags: [],
    capabilities: ['fake-image'],
    inputs: ['text'],
    outputs: ['image'],
    source: 'user',
    async call(input: unknown) {
      const inp = input as { prompt?: string }
      calls.push({ prompt: inp.prompt ?? '' })
      const id = serial++
      return {
        output: {
          modality: 'image',
          assetId: `img-${id}`,
          prompt: inp.prompt ?? '',
        },
      } as unknown
    },
  } as unknown as ModelCapability

  return {
    checkSatisfiable: () => ({ ok: true, candidates: [cap] }),
    resolve: () => cap,
  } as unknown as CapabilityRouter
}

function createFakeImagePattern(): AtomicPattern<{ prompt: string }, unknown> {
  return {
    id: 'fake-image',
    kind: 'atomic',
    description: 'fake image gen for deep-nesting test',
    outputs: z.any() as never,
    primary: {
      tool: { description: 'fake', inputs: z.object({ prompt: z.string() }) },
      modelTags: [],
    },
  }
}

// ── Level 3: grandchild meta — one fixed-id step into the atomic image gen.
//    The 'gc-step' id is identical across every grandchild instance; only the
//    recursive namespace prefix keeps the four of them apart.
function createGrandchildMeta(): MetaPattern<{ prompt: string }, { assetId: string }> {
  return {
    id: 'meta_grandchild',
    kind: 'meta',
    description: 'grandchild — one fixed-id image step',
    outputs: z.any() as never,
    tool: { description: 'gc', inputs: z.object({ prompt: z.string() }) },
    async compose({ input }, ctx) {
      const img = await ctx.step<{ assetId: string }>(
        { patternId: 'fake-image', input: { prompt: `gc:${input.prompt}` } },
        { stepId: 'gc-step' },
      )
      return { assetId: img.assetId }
    },
  }
}

// ── Level 2: child meta — dispatches the grandchild twice with fixed stepIds.
function createChildMeta(): MetaPattern<{ prompt: string }, { a: string; b: string }> {
  return {
    id: 'meta_child',
    kind: 'meta',
    description: 'child — two grandchild dispatches',
    outputs: z.any() as never,
    tool: { description: 'child', inputs: z.object({ prompt: z.string() }) },
    async compose({ input }, ctx) {
      const r0 = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_grandchild', input: { prompt: `${input.prompt}-0` } },
        { stepId: 'gc-0' },
      )
      const r1 = await ctx.step<{ assetId: string }>(
        { patternId: 'meta_grandchild', input: { prompt: `${input.prompt}-1` } },
        { stepId: 'gc-1' },
      )
      return { a: r0.assetId, b: r1.assetId }
    },
  }
}

// ── Level 1: parent meta — dispatches the child twice with fixed stepIds.
//    Mirrors the idea2video → script2video × N_scenes storyboard shape.
function createParentMeta(): MetaPattern<
  Record<string, never>,
  { p0: { a: string; b: string }; p1: { a: string; b: string } }
> {
  return {
    id: 'meta_parent',
    kind: 'meta',
    description: 'parent — two child dispatches',
    outputs: z.any() as never,
    tool: { description: 'parent', inputs: z.object({}) },
    async compose(_params, ctx) {
      const p0 = await ctx.step<{ a: string; b: string }>(
        { patternId: 'meta_child', input: { prompt: 'scene-0' } },
        { stepId: 'child-0' },
      )
      const p1 = await ctx.step<{ a: string; b: string }>(
        { patternId: 'meta_child', input: { prompt: 'scene-1' } },
        { stepId: 'child-1' },
      )
      return { p0, p1 }
    },
  }
}

function makeRuntime(calls: Array<{ prompt: string }>): InlineRuntime {
  const registry = new PatternRegistry()
  registry.add(createFakeImagePattern() as never)
  registry.add(createGrandchildMeta() as never)
  registry.add(createChildMeta() as never)
  registry.add(createParentMeta() as never)
  return new InlineRuntime({
    router: makeImageRouter(calls),
    registry,
    store: new MemoryJobStore() as never,
  })
}

describe('meta step-cache — three-level nesting (ADR-009 §A.5)', () => {
  it('does not crash DUPLICATE_STEP_ID with three levels of fixed-id steps', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    // A broken recursive prefix would collide 'gc-step' (or 'gc-0'/'gc-1')
    // across sibling subtrees and reject with DUPLICATE_STEP_ID.
    expect(job.status).toBe('done')
    expect(job.error).toBeNull()
  })

  it('each grandchild gets its own model call — no cross-level cache sharing', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    await runtime.submitJob({ patternId: 'meta_parent', input: {} } as never)

    // 2 children × 2 grandchildren × 1 image = 4. If the namespace prefix only
    // applied one level, the second child's grandchildren would hit the first
    // child's cached 'gc-step' result → fewer than 4 calls.
    expect(calls).toHaveLength(4)

    const prompts = calls.map((c) => c.prompt)
    expect(prompts).toEqual([
      'gc:scene-0-0',
      'gc:scene-0-1',
      'gc:scene-1-0',
      'gc:scene-1-1',
    ])
    expect(new Set(prompts).size).toBe(4)
  })

  it('output assetIds are all distinct — no aliasing from a shared cache slot', async () => {
    const calls: Array<{ prompt: string }> = []
    const runtime = makeRuntime(calls)

    const job = await runtime.submitJob({
      patternId: 'meta_parent',
      input: {},
    } as never)

    const out = job.output as unknown as {
      p0: { a: string; b: string }
      p1: { a: string; b: string }
    }

    const all = [out.p0.a, out.p0.b, out.p1.a, out.p1.b]
    expect(all).toEqual(['img-0', 'img-1', 'img-2', 'img-3'])
    expect(new Set(all).size).toBe(4)
  })
})
