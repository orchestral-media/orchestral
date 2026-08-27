import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  silentDiagnosticsLogger,
  buildAssetIndex,
  resolveAssetReferences,
  PatternRegistry,
  DEFAULT_AGENT_FINISH_SPEC,
  defaultAgentFinishOutputs,
  type AgentPattern,
} from '@orchestral/core'

import {
  createExplainerShortMeta,
  createImageBestOfNMeta,
  createImageToImageViaCaptionPattern,
  createProductAdShortMeta,
  createProductPhotoPackMeta,
  createScript2VideoMeta,
  createStoryboardMeta,
  createUgcTestimonialMeta,
  FIRST_PARTY_PATTERN_IDS,
  PLAN_PATTERN_ID,
} from '@orchestral/patterns'

import {
  createOrchestratorAgent,
  AGENT_ORCHESTRATOR_PATTERN_ID,
  ORCHESTRATOR_DEFAULT_PROMPTS,
} from '../orchestrator'
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../orchestrator/prompts'

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

  it('is per-surface visible to chat-turn + agent-loop and always-load', () => {
    const agent = createOrchestratorAgent()

    // Object-form exposure: the main chat-turn AND any parent agent loop may
    // delegate to it.
    expect(agent.exposure).toEqual({ chatTurn: true, agentLoop: true })
    // Surfaced as a first-class chat-turn tool (one-hop delegation).
    expect(agent.exposureMode).toBe('always-load')
  })

  it('renders loop.system with a cache-stable system-prompt prefix and a per-dispatch run-parameters suffix', () => {
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

    // ORCHESTRATOR_SYSTEM_PROMPT anchors the start of both renders — the cacheable prefix
    // is identical across dispatches regardless of the per-run extras.
    expect(sysA.indexOf(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(0)
    expect(sysB.indexOf(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(0)
    const prefixLen = sysA.indexOf('## RUN PARAMETERS')
    expect(prefixLen).toBeGreaterThan(0)
    expect(sysA.slice(0, prefixLen)).toBe(sysB.slice(0, prefixLen))

    // No embedded prompt block — the orchestrator's whole system prompt is the
    // one constant, and it tells the LLM there is no further guidance to go
    // and fetch.
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

  it('takes its tool universe from the shipped first-party catalog, minus meta_plan', () => {
    const agent = createOrchestratorAgent()

    // The assertion is the DIFFERENCE against @orchestral/patterns' catalog,
    // not a second copy of the id list. A first-party Pattern added, renamed
    // or dropped over there now shows up here as an unexplained gap — the old
    // hand-copied expectation could not see one, which is how the list drifted.
    const catalog = [
      ...FIRST_PARTY_PATTERN_IDS.atomic,
      ...FIRST_PARTY_PATTERN_IDS.meta,
    ]
    expect(agent.loop.toolPatternIds).toEqual(
      catalog.filter((id) => id !== PLAN_PATTERN_ID),
    )

    // The one deliberate exclusion: the orchestrator plans as it goes, so
    // submitting a static DAG overlaps with its own scheduling authority.
    expect(agent.loop.toolPatternIds).not.toContain(PLAN_PATTERN_ID)

    // No agent_* in the universe — orchestration composes atomics + metas, not
    // agents (and never itself). Structural, not a filter: kind:'agent'
    // patterns live in this package, so the catalog carries none.
    for (const id of agent.loop.toolPatternIds) {
      expect(id.startsWith('agent_')).toBe(false)
    }
    expect(agent.loop.toolPatternIds).not.toContain(AGENT_ORCHESTRATOR_PATTERN_ID)
  })

  it('grants the inner dispatches every meta it lists declares', () => {
    // The shipped metas declare what they will dispatch, and the runtime holds
    // a declaring meta's ids to THIS allowlist before submitting the child. So
    // listing a meta without the patterns it is made of is not a narrower
    // agent — it is an agent whose every call to that meta is refused up front
    // with SUBAGENT_TOOL_OUT_OF_SCOPE. The two lists have to be read together,
    // and this is what reads them.
    const allow = new Set<string>(createOrchestratorAgent().loop.toolPatternIds)
    const noop = async () => ({ assetId: 'x' })
    const metas = [
      createImageToImageViaCaptionPattern(),
      createScript2VideoMeta({ concatVideos: noop }),
      createImageBestOfNMeta(),
      createStoryboardMeta(),
      createProductAdShortMeta({
        addBackgroundAudio: noop,
        recordSessionAsset: async () => ({ handle: 'image_1' }),
      }),
      createProductPhotoPackMeta(),
      createUgcTestimonialMeta({
        concatVideos: noop,
        addBackgroundAudio: noop,
        addSubtitles: noop,
        createSubtitleAsset: noop,
      }),
      createExplainerShortMeta({ concatVideos: noop, stillToVideo: noop }),
    ]

    for (const meta of metas) {
      expect(allow.has(meta.id), `${meta.id} listed`).toBe(true)
      // Both branches of the one declaration that reads its input: an empty
      // input takes image-best-of-n's image-to-image fallback.
      const declared = [
        ...(meta.plannedDispatches?.({} as never) ?? []),
        ...(meta.plannedDispatches?.({ innerPatternId: 'text-to-image' } as never) ?? []),
      ]
      for (const inner of declared) {
        expect(allow.has(inner), `${meta.id} declares ${inner}`).toBe(true)
      }
    }
  })

  it('declares no asyncToolPatternIds — one catalog, because it never runs in async mode', () => {
    const agent = createOrchestratorAgent()

    // The second catalog filter only engages at defaultExecutionMode ===
    // 'async', which this pattern deliberately never sets. A list that cannot
    // be reached is a list nothing keeps honest: the old one claimed to route
    // long-running sub-dispatches through async fan-out, which is not what the
    // field does (it prunes a catalog) and not what this agent does (it has
    // one catalog).
    expect('asyncToolPatternIds' in agent.loop).toBe(false)
    expect('defaultExecutionMode' in agent).toBe(false)
  })

  it('exports its default prompt and merges an override without dropping the rest', () => {
    // Same treatment every shipped meta gets (*_DEFAULT_PROMPTS + a `prompts`
    // override merged by resolvePrompts): tone / house style / localization is
    // a consumer decision, and the alternative here was forking a package
    // whose entire content is this declaration.
    expect(ORCHESTRATOR_DEFAULT_PROMPTS.orchestratorSystem).toBe(
      ORCHESTRATOR_SYSTEM_PROMPT,
    )
    expect(Object.isFrozen(ORCHESTRATOR_DEFAULT_PROMPTS)).toBe(true)

    const custom = createOrchestratorAgent({
      prompts: { orchestratorSystem: 'CUSTOM ORCHESTRATOR CONTRACT' },
    })
    const rendered = (custom.loop.system as (i: unknown, c: unknown) => string)(
      { description: 'd', prompt: 'p', style: 'noir' },
      {},
    )
    // The override replaces the cached prefix …
    expect(rendered.indexOf('CUSTOM ORCHESTRATOR CONTRACT')).toBe(0)
    expect(rendered).not.toContain('You CANNOT see the pixels/frames/audio')
    // … and the per-dispatch suffix, which is factory machinery rather than
    // prompt content, survives it.
    expect(rendered).toContain('## RUN PARAMETERS (this dispatch)')
    expect(rendered).toContain('Overall style: noir')

    // An empty override map changes nothing (resolvePrompts semantics).
    const untouched = createOrchestratorAgent({ prompts: {} })
    expect(
      (untouched.loop.system as (i: unknown, c: unknown) => string)(
        { description: 'd', prompt: 'p' },
        {},
      ).indexOf(ORCHESTRATOR_SYSTEM_PROMPT),
    ).toBe(0)
  })

  it('lets the host narrow the tool universe and take back abort policy', () => {
    // Both are host policy the package only picked a default for (P2): which
    // Patterns this deployment will pay for, and whether the dispatching turn
    // ending should kill the run.
    const narrowed = createOrchestratorAgent({
      toolPatternIds: ['text-to-image', 'meta_storyboard'],
      abortMode: 'inherit',
    })
    expect(narrowed.loop.toolPatternIds).toEqual([
      'text-to-image',
      'meta_storyboard',
    ])
    expect(narrowed.loop.abortMode).toBe('inherit')

    // Defaults are untouched by another call's init — the factory must not
    // share mutable state between agents.
    const plain = createOrchestratorAgent()
    expect(plain.loop.abortMode).toBe('independent')
    expect(plain.loop.toolPatternIds.length).toBeGreaterThan(2)
  })

  it('does not declare a stopWhen — the host owns the stop policy', () => {
    const agent = createOrchestratorAgent()
    expect('stopWhen' in agent.loop).toBe(false)
  })

  it('runs abort-independent so it survives the dispatching turn ending', () => {
    const agent = createOrchestratorAgent()
    // Dispatched async fire-and-forget from the chat-turn: the parent turn's
    // abort signal must NOT cascade in and kill it.
    expect(agent.loop.abortMode).toBe('independent')
  })

  it('tool description tells the LLM the call is async fire-and-forget', () => {
    const agent = createOrchestratorAgent()
    const desc = agent.primary!.tool.description.toLowerCase()
    // Assert the specific anti-poll contract phrase, not the incidental word
    // "async" (which recurs and would let this false-pass if the contract were
    // dropped).
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

    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
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
        // context's announcement label. An uploaded asset's handle is its
        // filename, which is why the fixture handle looks like one.
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
