import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  PatternRegistry,
  DEFAULT_AGENT_FINISH_SPEC,
  defaultAgentFinishOutputs,
  type AgentPattern,
} from '@orchestral/core'

import {
  createLongFormVideoAgent,
  AGENT_LONG_FORM_VIDEO_PATTERN_ID,
} from '../long-form-video'
import {
  LONG_FORM_VIDEO_DIRECTOR_PROMPT,
  CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT,
} from '../long-form-video/prompts'

// Post-split the director + character-merge SKILL bodies are INLINED in the
// pattern (no longer host-injected deps), and ADR-028 moved the agent's host
// tools (concat_videos / complete_task) host-side by patternId — the factory
// is now no-arg and the Pattern carries no `customTools` array. The baked
// prompts are asserted against the real exported constants.

describe('agent_long-form-video', () => {
  it('declares a stable agent Pattern with the expected id, kind, namespace, and primary surface', () => {
    const agent = createLongFormVideoAgent()

    expect(agent.id).toBe(AGENT_LONG_FORM_VIDEO_PATTERN_ID)
    expect(agent.id).toBe('agent_long-form-video')
    expect(agent.kind).toBe('agent')
    expect(agent.namespace).toBe('meta-pipelines')
    expect(agent.searchHint).toContain('long-form')
    expect(agent.searchHint).toContain('novel')
    expect(agent.primary).toBeDefined()
    expect(agent.primary!.tool.description).toContain('long-form')
  })

  it('renders loop.system with a cache-stable SKILL prefix and a per-dispatch run-parameters suffix (ADR-008)', () => {
    const agent = createLongFormVideoAgent()

    // system is a function: framework extras (style/maxEvents) vary per
    // dispatch, so they're appended after the cacheable prefix.
    expect(typeof agent.loop.system).toBe('function')
    const systemFn = agent.loop.system as (
      input: unknown,
      ctx: unknown,
    ) => string

    const sysA = systemFn(
      { description: 'd', prompt: 'novel A', style: 'noir', maxEvents: 12 },
      {},
    )
    const sysB = systemFn(
      { description: 'd', prompt: 'novel B', maxEvents: 99 },
      {},
    )

    // The inlined director body anchors the start of both — the cacheable
    // prefix is identical across dispatches regardless of the per-run extras.
    expect(sysA.indexOf(LONG_FORM_VIDEO_DIRECTOR_PROMPT)).toBe(0)
    expect(sysB.indexOf(LONG_FORM_VIDEO_DIRECTOR_PROMPT)).toBe(0)
    const prefixLen = sysA.indexOf('## RUN PARAMETERS')
    expect(prefixLen).toBeGreaterThan(0)
    expect(sysA.slice(0, prefixLen)).toBe(sysB.slice(0, prefixLen))

    // Inlined character-merge body fenced in the prefix — the LLM copies it
    // verbatim into Stage 3.2's text-generation `system`.
    expect(sysA).toContain('<EMBEDDED_SKILL_CHARACTER_MERGE_EVENT_TO_NOVEL>')
    expect(sysA).toContain(CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT)
    expect(sysA).toContain('</EMBEDDED_SKILL_CHARACTER_MERGE_EVENT_TO_NOVEL>')

    // Per-dispatch suffix carries the typed extras.
    expect(sysA).toContain('Visual style: noir')
    expect(sysA).toContain('maxEvents): 12')
    // Omitted style → inference hint; omitted maxEvents → default 50.
    expect(sysB).toContain('infer a single consistent style')
    expect(sysB).toContain('maxEvents): 99')
  })

  it('names the live host tools without the removed base namespace', () => {
    expect(LONG_FORM_VIDEO_DIRECTOR_PROMPT).toContain('`concat_videos`')
    expect(LONG_FORM_VIDEO_DIRECTOR_PROMPT).toContain('`complete_task`')
    expect(LONG_FORM_VIDEO_DIRECTOR_PROMPT).not.toMatch(/\bbase\.[a-z_]+\b/)
  })

  it('defines the structured Stage 3.2 fold, Stage 4 projection, and selective resume contract', () => {
    const stage32Start = LONG_FORM_VIDEO_DIRECTOR_PROMPT.indexOf(
      '2. Promote the event-scope character registry',
    )
    const stage4Start = LONG_FORM_VIDEO_DIRECTOR_PROMPT.indexOf(
      '### Stage 4 — per-scene rendering',
    )
    const stage5Start = LONG_FORM_VIDEO_DIRECTOR_PROMPT.indexOf(
      '### Stage 5 — concatenate and finish',
    )
    const resumeStart = LONG_FORM_VIDEO_DIRECTOR_PROMPT.indexOf(
      '## RESUME AWARENESS',
    )
    const decisionPolicyStart = LONG_FORM_VIDEO_DIRECTOR_PROMPT.indexOf(
      '## DECISION POLICY',
    )

    expect(stage32Start).toBeGreaterThanOrEqual(0)
    expect(stage4Start).toBeGreaterThan(stage32Start)
    expect(stage5Start).toBeGreaterThan(stage4Start)
    expect(resumeStart).toBeGreaterThan(stage5Start)
    expect(decisionPolicyStart).toBeGreaterThan(resumeStart)

    const stage32 = LONG_FORM_VIDEO_DIRECTOR_PROMPT.slice(
      stage32Start,
      stage4Start,
    )
    const stage4 = LONG_FORM_VIDEO_DIRECTOR_PROMPT.slice(
      stage4Start,
      stage5Start,
    )
    const resume = LONG_FORM_VIDEO_DIRECTOR_PROMPT.slice(
      resumeStart,
      decisionPolicyStart,
    )

    expect(stage32).toContain("responseFormat: 'json'")
    expect(stage32).toContain('jsonSchema: {')
    expect(stage32.match(/type: 'object'/g)).toHaveLength(2)
    expect(stage32).toContain("required: ['characters']")
    expect(stage32).toContain("type: 'array'")
    expect(stage32.match(/additionalProperties: false/g)).toHaveLength(2)
    expect(stage32).toContain(
      "required: ['index_in_event', 'index_in_novel', 'identifier_in_novel', 'modified_features']",
    )
    expect(stage32).toContain(
      "index_in_event: { type: 'integer', minimum: 0 }",
    )
    expect(stage32).toContain(
      "index_in_novel: { type: 'integer', minimum: -1 }",
    )
    expect(stage32).toContain(
      "identifier_in_novel: { type: 'string' }",
    )
    expect(stage32).toContain("modified_features: { type: 'string' }")
    expect(stage32).toContain(
      'Parse that `text` as the schema-constrained object',
    )
    expect(stage32).toContain(
      'read its `characters` array as merge instructions',
    )

    expect(stage32).toContain('type CharacterInNovel = {')
    expect(stage32).toContain('index: number')
    expect(stage32).toContain('identifier_in_novel: string')
    expect(stage32).toContain('active_events: Record<string, string>')
    expect(stage32).toContain('static_features: string')
    expect(stage32).toContain('index_in_novel === -1')
    expect(stage32).toContain('index: novelCharRegistry.length')
    expect(stage32).toContain(
      'static_features: instruction.modified_features',
    )
    expect(stage32).toContain(
      'active_events: { [event.index]: eventChar.identifier_in_event }',
    )
    expect(stage32).toContain(
      'eventCharRegistry[instruction.index_in_event]',
    )
    expect(stage32).toContain(
      'novelChar.static_features = instruction.modified_features',
    )
    expect(stage32).toContain(
      'novelChar.active_events[event.index] = eventChar.identifier_in_event',
    )
    expect(stage32).toMatch(/folded registry is the single canonical state/i)
    expect(stage32).toMatch(
      /merge response does not replace (?:your tracked )?`novelCharRegistry`/i,
    )

    for (const key of [
      'idx',
      'identifierInScene',
      'staticFeatures',
      'dynamicFeatures',
      'isVisible',
    ]) {
      expect(stage4).toContain(key)
    }
    expect(stage4).toContain('staticFeatures: novelChar.static_features')
    expect(stage4).toMatch(
      /other fields come from the matching original scene character/i,
    )
    expect(stage4).toMatch(
      /do not pass .*snake_case.*static_features.*directly/i,
    )

    expect(resume).toMatch(
      /older Stage 3\.2 result cannot be replayed as this merge shape/i,
    )
    expect(resume).toContain('rerun only Stage 3.2')
    expect(resume).toContain('already-recorded `eventCharRegistry`')
    expect(resume).toMatch(/do not rerun Stage 3\.1 or rendered scenes/i)
  })

  it('whitelists the full long-form tool catalog in loop.toolPatternIds', () => {
    const agent = createLongFormVideoAgent()

    // The agent must be able to reach every meta + atomic it orchestrates,
    // and only those. Order is part of the contract — it shapes the
    // catalog order the LLM sees.
    expect(agent.loop.toolPatternIds).toEqual([
      'meta_prose-chunking',
      'meta_novel-to-events',
      'meta_event-to-script',
      'meta_script2video',
      'meta_image-best-of-n',
      'text-generation',
    ])
  })

  it('flags long-running sub-dispatches via asyncToolPatternIds', () => {
    const agent = createLongFormVideoAgent()

    // meta_script2video + meta_image-best-of-n take minutes; the agent loop
    // can't block on them synchronously. asyncToolPatternIds is the agent
    // path the host uses to route them through the async fan-out plumbing.
    expect(agent.loop.asyncToolPatternIds).toEqual([
      'meta_script2video',
      'meta_image-best-of-n',
    ])

    // Async list must be a subset of toolPatternIds.
    const toolSet = new Set(agent.loop.toolPatternIds)
    for (const t of agent.loop.asyncToolPatternIds!) {
      expect(toolSet.has(t)).toBe(true)
    }
  })

  it('declares no custom outputs / finish — the registry backfills the default finish envelope', () => {
    // The old schema demanded the model self-report videoAssetId / sceneCount /
    // eventCount / cost / interruptions — all write-only telemetry, and under
    // the D3 projection the model only ever sees handles, never asset ids.
    // Migrated: the director hands back summary + deliverable handles via
    // complete_task, and the registry backfills the default {assets, summary,
    // stepCount} envelope since the pattern declares neither outputs nor finish.
    const agent = createLongFormVideoAgent()
    expect(agent.outputs).toBeUndefined()
    expect(agent.finish).toBeUndefined()

    const reg = new PatternRegistry()
    reg.register(agent)
    const stored = reg.get(AGENT_LONG_FORM_VIDEO_PATTERN_ID) as AgentPattern
    // Reference identity: the backfill installs the shared canonical defaults,
    // not a per-pattern copy.
    expect(stored.outputs).toBe(defaultAgentFinishOutputs)
    expect(stored.finish).toBe(DEFAULT_AGENT_FINISH_SPEC)
  })

  it('input schema is built via agentInputSchema (framework description + prompt seed) plus typed extras', () => {
    const agent = createLongFormVideoAgent()
    const inputSchema = agent.primary!.tool.inputs as unknown as z.ZodSchema

    // Framework base fields — description + prompt (the seed user message,
    // which carries the novel). dispatchAgent throws AGENT_SEED_PROMPT_MISSING
    // without a non-empty prompt, so the schema must require it.
    expect(() =>
      inputSchema.parse({
        description: 'long-form video',
        prompt: 'Adapt this novel into a long-form video: <prose...>',
      }),
    ).not.toThrow()

    // With optional typed extras.
    expect(() =>
      inputSchema.parse({
        description: 'long-form video',
        prompt: 'Adapt this novel: <prose>',
        style: 'noir, black-and-white',
        maxEvents: 12,
      }),
    ).not.toThrow()

    // Missing prompt is rejected (would otherwise fail at dispatch).
    expect(() => inputSchema.parse({ description: 'x' })).toThrow()

    // Missing description is rejected.
    expect(() => inputSchema.parse({ prompt: 'some brief' })).toThrow()

    // maxEvents above the 500 cap is rejected.
    expect(() =>
      inputSchema.parse({
        description: 'x',
        prompt: 'y',
        maxEvents: 1000,
      }),
    ).toThrow()

    // The legacy `novel` field is no longer part of the schema — the novel
    // rides in `prompt`. (zod objects strip unknown keys by default, so
    // passing it is harmless but it is not a declared field.)
    const parsed = inputSchema.parse({
      description: 'x',
      prompt: 'y',
      novel: 'z',
    }) as Record<string, unknown>
    expect(parsed.novel).toBeUndefined()
  })

  it('produces the same Pattern object shape across calls (memoisable by host)', () => {
    const a = createLongFormVideoAgent()
    const b = createLongFormVideoAgent()

    expect(a.id).toBe(b.id)
    // loop.system is a function (per-dispatch extras); two factory calls
    // yield distinct closures, but rendering the same input must produce
    // byte-identical system prompts (same inlined SKILL bodies in, same out).
    const sampleInput = { description: 'd', prompt: 'p', maxEvents: 7 }
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
