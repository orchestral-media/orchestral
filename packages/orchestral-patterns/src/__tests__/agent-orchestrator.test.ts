import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildAssetIndex,
  resolveAssetReferences,
  PatternRegistry,
  DEFAULT_AGENT_FINISH_SPEC,
  defaultAgentFinishOutputs,
  type AgentPattern,
} from '@orchestral/core'

import {
  createOrchestratorAgent,
  AGENT_ORCHESTRATOR_PATTERN_ID,
} from '../agent/orchestrator'
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../agent/orchestrator/prompts'

describe('agent_orchestrator', () => {
  it('declares a stable agent Pattern with the expected id, kind, namespace, and primary surface', () => {
    const agent = createOrchestratorAgent()

    expect(agent.id).toBe(AGENT_ORCHESTRATOR_PATTERN_ID)
    expect(agent.id).toBe('agent_orchestrator')
    expect(agent.kind).toBe('agent')
    expect(agent.namespace).toBe('meta-pipelines')
    expect(agent.searchHint).toContain('orchestrate')
    expect(agent.searchHint).toContain('multi-step media')
    expect(agent.primary).toBeDefined()
    expect(agent.primary!.tool.description).toContain('open-ended')
  })

  it('is per-surface visible to chat-turn + agent-loop and always-load (ADR-030 F / Phase 3)', () => {
    const agent = createOrchestratorAgent()

    // Object-form exposure: the main chat-turn AND any parent agent loop may
    // delegate to it.
    expect(agent.exposure).toEqual({ chatTurn: true, agentLoop: true })
    // Surfaced as a first-class chat-turn tool (one-hop delegation).
    expect(agent.exposureMode).toBe('always-load')
  })

  it('renders loop.system with a cache-stable C1 prefix and a per-dispatch run-parameters suffix (ADR-008)', () => {
    const agent = createOrchestratorAgent()

    expect(typeof agent.loop.system).toBe('function')
    const systemFn = agent.loop.system as (
      input: unknown,
      ctx: unknown,
    ) => string

    const sysA = systemFn(
      { description: 'd', prompt: 'brief A', style: 'noir' },
      {},
    )
    const sysB = systemFn({ description: 'd', prompt: 'brief B' }, {})

    // The C1 constant anchors the start of both renders — the cacheable prefix
    // is identical across dispatches regardless of the per-run extras.
    expect(sysA.indexOf(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(0)
    expect(sysB.indexOf(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(0)
    const prefixLen = sysA.indexOf('## RUN PARAMETERS')
    expect(prefixLen).toBeGreaterThan(0)
    expect(sysA.slice(0, prefixLen)).toBe(sysB.slice(0, prefixLen))

    // No embedded prompt block — unlike long-form-video, the orchestrator's
    // whole system prompt is the one constant, and it tells the LLM there is
    // no further guidance to go and fetch.
    expect(sysA).not.toContain('EMBEDDED_SKILL')
    expect(sysA).toContain('there is nothing further for you to go and fetch')

    // Vision-blindness guard: the prompt must tell the LLM it cannot see its
    // own produced media and must not dispatch describe/caption to self-verify
    // (net-log 2026-06-12: orchestrator flailed dispatching image-to-text to
    // "check" its outputs when the user's vision route was failing).
    expect(sysA).toContain('You CANNOT see the pixels/frames/audio')
    expect(sysA).toMatch(/Never dispatch an image-to-text \/ caption \/ describe/)
    expect(sysA).toContain('Judge each step from its tool result, not by looking')

    // Consistency-workflow guidance: identity-preserving steps must go through
    // image-to-image with reference sources, and a multi-subject frame must
    // fuse every character's reference (live test: orchestrator defaulted to
    // text-to-image / single-source and dropped cross-shot character identity).
    expect(sysA).toContain('Consistency:')
    expect(sysA).toContain('use image-to-image and pass those characters')
    expect(sysA).toContain('Multiple subjects in one frame')
    expect(sysA).toContain('array order')
    // Multi-panel sequences should reach for the meta_storyboard pattern rather
    // than hand-composing per-panel i2i steps.
    expect(sysA).toContain('meta_storyboard')
    expect(sysA).toContain('multi-panel storyboard')

    // Per-dispatch suffix carries the typed style extra.
    expect(sysA).toContain('Overall style: noir')
    // Omitted style → inference hint.
    expect(sysB).toContain('infer a consistent style')
  })

  it('whitelists a broad atomic + meta universe and excludes every agent kind in loop.toolPatternIds', () => {
    const agent = createOrchestratorAgent()

    // Order is part of the contract — it shapes the catalog order the LLM sees.
    expect(agent.loop.toolPatternIds).toEqual([
      'text-to-image',
      'image-to-image',
      'text-to-video',
      'image-to-video',
      'video-to-video',
      'text-to-speech',
      'text-to-audio',
      'automatic-speech-recognition',
      'image-to-text',
      'text-generation',
      'meta_image-to-image-via-caption',
      'meta_idea2video',
      'meta_script2video',
      'meta_image-best-of-n',
      'meta_reference-image-cascade',
      'meta_script-planning',
      'meta_storyboard',
      'meta_product-ad-short',
      'meta_product-photo-pack',
      'meta_ugc-testimonial',
      'meta_explainer-short',
      'meta_lyrics-to-mv',
      'meta_prose-chunking',
      'meta_novel-to-events',
      'meta_event-to-script',
    ])

    // No agent_* in the universe — orchestration composes atomics + metas, not
    // agents (and never itself).
    for (const id of agent.loop.toolPatternIds) {
      expect(id.startsWith('agent_')).toBe(false)
    }
    expect(agent.loop.toolPatternIds).not.toContain(AGENT_ORCHESTRATOR_PATTERN_ID)
  })

  it('flags long-running sub-dispatches via asyncToolPatternIds (subset of toolPatternIds)', () => {
    const agent = createOrchestratorAgent()

    expect(agent.loop.asyncToolPatternIds).toEqual([
      'meta_idea2video',
      'meta_script2video',
      'meta_image-best-of-n',
      'meta_storyboard',
      'meta_product-ad-short',
      'meta_product-photo-pack',
      'meta_ugc-testimonial',
      'meta_explainer-short',
      'meta_lyrics-to-mv',
    ])

    const toolSet = new Set(agent.loop.toolPatternIds)
    for (const t of agent.loop.asyncToolPatternIds!) {
      expect(toolSet.has(t)).toBe(true)
    }
  })

  it('does not declare a stopWhen (ADR-032 Phase B — host owns the stop policy)', () => {
    const agent = createOrchestratorAgent()
    expect('stopWhen' in agent.loop).toBe(false)
  })

  it('runs abort-independent so it survives the dispatching turn ending (spec §3.A / A2)', () => {
    const agent = createOrchestratorAgent()
    // Dispatched async fire-and-forget from the chat-turn: the parent turn's
    // abort signal must NOT cascade in and kill it.
    expect(agent.loop.abortMode).toBe('independent')
  })

  it('tool description tells the LLM the call is async fire-and-forget (spec §3.A / A2)', () => {
    const agent = createOrchestratorAgent()
    const desc = agent.primary!.tool.description.toLowerCase()
    // Assert the specific anti-poll contract phrase, not the incidental word
    // "async" (which recurs and would let this false-pass if the contract were
    // dropped) — per code-review minor.
    expect(desc).toMatch(/do not wait or poll/)
  })

  it('input schema requires description + prompt and accepts the typed extras', () => {
    const agent = createOrchestratorAgent()
    const inputSchema = agent.primary!.tool.inputs as unknown as z.ZodSchema

    // Minimal valid input — description + prompt (the seed user message).
    expect(() =>
      inputSchema.parse({
        description: 'product promo',
        prompt: 'Produce a 3-shot promo for the attached product photo.',
      }),
    ).not.toThrow()

    // With optional typed extras — references as the framework slot record
    // (P2: derived from assetNeeds, handles keyed by per-modality slot).
    expect(() =>
      inputSchema.parse({
        description: 'product promo',
        prompt: 'Produce a promo.',
        references: { images: ['image_2', 'image_5'] },
        style: 'cinematic, warm',
      }),
    ).not.toThrow()

    // Missing prompt is rejected (would otherwise fail at dispatch).
    expect(() => inputSchema.parse({ description: 'x' })).toThrow()
    // Missing description is rejected.
    expect(() => inputSchema.parse({ prompt: 'y' })).toThrow()
    // Undeclared slot key is rejected (derived references is a strict object).
    expect(() =>
      inputSchema.parse({
        description: 'x',
        prompt: 'y',
        references: { bogusSlot: 'image_1' },
      }),
    ).toThrow()
  })

  it('declares no custom outputs / finish — the registry backfills the default finish envelope', () => {
    // Under the finish contract the model hands back a summary + deliverable
    // HANDLES via complete_task; the runtime resolves handles and composes the
    // standard {assets, summary, stepCount} envelope. The pattern declares
    // neither outputs nor finish, so the registry backfills the default trio.
    const agent = createOrchestratorAgent()
    expect(agent.outputs).toBeUndefined()
    expect(agent.finish).toBeUndefined()

    const reg = new PatternRegistry()
    reg.register(agent)
    const stored = reg.get(AGENT_ORCHESTRATOR_PATTERN_ID) as AgentPattern
    // Reference identity: the backfill installs the shared canonical defaults,
    // not a per-pattern copy.
    expect(stored.outputs).toBe(defaultAgentFinishOutputs)
    expect(stored.finish).toBe(DEFAULT_AGENT_FINISH_SPEC)
  })

  describe('orchestrator asset slots (P2)', () => {
    // Minimal AssetIndex: one image asset with a host-supplied handle —
    // mirrors the construction pattern in orchestral-core's asset-index tests.
    function makeIndexWithImageHandle(handle: string) {
      return buildAssetIndex([
        {
          kind: 'asset',
          orderHint: 1,
          annotation: { assetId: 'asset-img-1', modality: 'image', handle },
        },
      ])
    }

    it('declares per-modality optional array assetNeeds', () => {
      const p = createOrchestratorAgent()
      expect(p.assetNeeds?.map((n) => n.slot)).toEqual([
        'images',
        'videos',
        'audios',
      ])
      expect(
        p.assetNeeds?.every((n) => !n.required && n.cardinality === 'array'),
      ).toBe(true)
    })

    it('tool inputs schema carries the derived slot-keyed references object', () => {
      const p = createOrchestratorAgent()
      const js = z.toJSONSchema(p.primary!.tool.inputs as z.ZodTypeAny, {
        target: 'draft-2020-12',
      }) as { properties: Record<string, { properties?: Record<string, unknown> }> }
      expect(Object.keys(js.properties.references?.properties ?? {})).toEqual([
        'images',
        'videos',
        'audios',
      ])
    })

    it('references resolve through the standard pass (no UNKNOWN_SLOT)', () => {
      const p = createOrchestratorAgent()
      const index = makeIndexWithImageHandle('284540.JPG')
      const res = resolveAssetReferences(
        { references: { images: ['284540.JPG'] } },
        p.assetNeeds ?? [],
        index,
      )
      expect(res.ok).toBe(true)
      if (res.ok) {
        // ResolvedAssetRef carries the real assetId AND the source handle it
        // resolved from — the host translates that parent handle into the child
        // context's announcement label (upload handle = filename, see bug).
        expect(res.assets).toEqual([
          { slot: 'images', assetId: 'asset-img-1', modality: 'image', handle: '284540.JPG' },
        ])
      }
    })

    it('no references at all resolves ok with empty assets (optional slots never auto-fill)', () => {
      const p = createOrchestratorAgent()
      const index = makeIndexWithImageHandle('284540.JPG')
      const res = resolveAssetReferences({}, p.assetNeeds ?? [], index)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.assets).toEqual([])
    })
  })

  it('produces a byte-identical system render across factory calls (memoisable by host)', () => {
    const a = createOrchestratorAgent()
    const b = createOrchestratorAgent()

    expect(a.id).toBe(b.id)
    const sampleInput = { description: 'd', prompt: 'p', style: 'noir' }
    const renderA = (a.loop.system as (i: unknown, c: unknown) => string)(
      sampleInput,
      {},
    )
    const renderB = (b.loop.system as (i: unknown, c: unknown) => string)(
      sampleInput,
      {},
    )
    expect(renderA).toBe(renderB)
    expect(a.loop.toolPatternIds).toEqual(b.loop.toolPatternIds)
  })
})
