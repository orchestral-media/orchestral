import { describe, expect, it } from 'vitest'

import type { ExecutionContext, StepOptions, PatternRef } from '@orchestral/core'
import { createNovelToEventsMeta, type Event } from '../patterns/novel-to-events'

interface RecordedStep {
  patternId: string
  input: Record<string, unknown>
  stepOptions: StepOptions | undefined
}

/**
 * Fake ExecutionContext that scripts a sequence of Event responses.
 *
 * `scriptedEvents` is consumed in order: each successive text-generation
 * dispatch returns the next entry. The chunking patternId (if invoked)
 * returns a canned aggregatedNarrative.
 */
function makeCtx(opts: {
  scriptedEvents: readonly Event[]
  chunkingAggregate?: string
  chunkingCost?: number
  eventCosts?: readonly number[]
}) {
  const recorded: RecordedStep[] = []
  let eventIdx = 0
  const ctx = {
    compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
    step: async <T>(ref: PatternRef, options?: StepOptions): Promise<T> => {
      recorded.push({
        patternId: ref.patternId,
        input: ref.input as Record<string, unknown>,
        stepOptions: options,
      })
      if (ref.patternId === 'meta_prose-chunking') {
        return {
          compressedChunks: ['c0'],
          aggregatedNarrative: opts.chunkingAggregate ?? 'aggregated',
          cost: opts.chunkingCost ?? 10,
          latencyMs: 500,
        } as unknown as T
      }
      // text-generation: return the next scripted event as JSON.
      const idx = eventIdx++
      const ev = opts.scriptedEvents[idx]
      if (ev === undefined) {
        throw new Error(`test: scripted ran out at iter ${idx}`)
      }
      return {
        modality: 'text',
        text: JSON.stringify(ev),
        cost: opts.eventCosts?.[idx] ?? 1,
        latencyMs: 50,
        model: 'm',
        provider: 'p',
      } as unknown as T
    },
  } as unknown as ExecutionContext
  return { ctx, recorded }
}

function ev(
  index: number,
  isLast: boolean,
  description = `event ${index} description`,
): Event {
  return {
    index,
    description,
    timeframe: `T${index}`,
    characters: `chars ${index}`,
    cause: `cause ${index}`,
    process: `process ${index}`,
    outcome: `outcome ${index}`,
    is_last: isLast,
  }
}

describe('meta_novel-to-events', () => {
  it('walks events sequentially until is_last and uses unique stepId per iteration', async () => {
    const meta = createNovelToEventsMeta()
    const { ctx, recorded } = makeCtx({
      scriptedEvents: [ev(0, false), ev(1, false), ev(2, true)],
    })

    const out = await meta.compose(
      { input: { prose: 'a short novel', compressBeyond: 0 } }, // disable chunking
      ctx,
    )

    // 3 text-gen calls (no chunking — short prose + disabled threshold).
    const textCalls = recorded.filter(
      (r) => r.patternId === 'text-generation',
    )
    expect(textCalls).toHaveLength(3)

    // stepIds are unique per iter — bypassing the stepCache so identical
    // "system+prompt prefix" don't collapse.
    expect(textCalls[0]!.stepOptions?.stepId).toBe('event-0')
    expect(textCalls[1]!.stepOptions?.stepId).toBe('event-1')
    expect(textCalls[2]!.stepOptions?.stepId).toBe('event-2')

    expect(out.events).toHaveLength(3)
    expect(out.events[2].is_last).toBe(true)
    // cost = 3 events × 1 + 0 chunking. latency = 3 × 50 (sequential).
    expect(out.cost).toBe(3)
    expect(out.latencyMs).toBe(150)
  })

  it('stops at maxEvents safeguard when the model never self-reports is_last', async () => {
    const meta = createNovelToEventsMeta()
    // 5 scripted events, all is_last=false. With maxEvents=3 we should stop
    // after the 3rd.
    const { ctx, recorded } = makeCtx({
      scriptedEvents: [
        ev(0, false),
        ev(1, false),
        ev(2, false),
        ev(3, false),
        ev(4, false),
      ],
    })

    const out = await meta.compose(
      { input: { prose: 'walking novel', maxEvents: 3, compressBeyond: 0 } },
      ctx,
    )

    expect(out.events).toHaveLength(3)
    expect(out.events[2].is_last).toBe(false) // never reached is_last
    expect(recorded.filter((r) => r.patternId === 'text-generation')).toHaveLength(3)
  })

  it('renders prior events in subsequent prompts so the SKILL can build on context', async () => {
    const meta = createNovelToEventsMeta()
    const { ctx, recorded } = makeCtx({
      scriptedEvents: [ev(0, false), ev(1, true)],
    })

    await meta.compose(
      { input: { prose: 'context novel', compressBeyond: 0 } },
      ctx,
    )

    const textCalls = recorded.filter((r) => r.patternId === 'text-generation')
    // First call: no prior events.
    const firstPrompt = String(textCalls[0]!.input.prompt)
    expect(firstPrompt).toContain('<NOVEL_TEXT_START>')
    expect(firstPrompt).toContain('context novel')
    expect(firstPrompt).toContain('<EXTRACTED_EVENTS_START>')
    expect(firstPrompt).toContain('<EXTRACTED_EVENTS_END>')
    // First call's events block is empty (no <Event N> tags before END).
    expect(firstPrompt).not.toContain('<Event 0>')

    // Second call: prior Event 0 rendered.
    const secondPrompt = String(textCalls[1]!.input.prompt)
    expect(secondPrompt).toContain('<Event 0>')
    expect(secondPrompt).toContain('Description: event 0 description')
    expect(secondPrompt).toContain('Timeframe: T0')
    expect(secondPrompt).toContain('Outcome: outcome 0')
  })

  it('pre-compresses via meta_prose-chunking when prose exceeds compressBeyond', async () => {
    const meta = createNovelToEventsMeta()
    const { ctx, recorded } = makeCtx({
      scriptedEvents: [ev(0, true)], // 1 event, is_last
      chunkingAggregate: 'compressed novel',
    })

    // prose > compressBeyond default 60_000. Use a small explicit threshold.
    const longProse = 'X'.repeat(2000)
    await meta.compose(
      { input: { prose: longProse, compressBeyond: 1000 } },
      ctx,
    )

    const chunkingCalls = recorded.filter(
      (r) => r.patternId === 'meta_prose-chunking',
    )
    expect(chunkingCalls).toHaveLength(1)
    expect((chunkingCalls[0]!.input as { prose: string }).prose).toBe(longProse)

    // Event extraction prompt should carry the aggregated narrative, NOT
    // the raw prose — that's the whole point of pre-compression.
    const textCalls = recorded.filter((r) => r.patternId === 'text-generation')
    const evPrompt = String(textCalls[0]!.input.prompt)
    expect(evPrompt).toContain('compressed novel')
    expect(evPrompt).not.toContain(longProse)
  })

  it('skips pre-compression when prose is shorter than compressBeyond', async () => {
    const meta = createNovelToEventsMeta()
    const { ctx, recorded } = makeCtx({
      scriptedEvents: [ev(0, true)],
    })

    await meta.compose(
      { input: { prose: 'tiny', compressBeyond: 1_000_000 } }, // huge threshold
      ctx,
    )

    expect(
      recorded.filter((r) => r.patternId === 'meta_prose-chunking'),
    ).toHaveLength(0)
    const evPrompt = String(
      (recorded[0]!.input as { prompt: string }).prompt,
    )
    expect(evPrompt).toContain('tiny')
  })

  it('keeps cost finite when chunking and a mid-loop event report NaN (sumCosts guard)', async () => {
    const meta = createNovelToEventsMeta()
    const { ctx } = makeCtx({
      scriptedEvents: [ev(0, false), ev(1, false), ev(2, true)],
      chunkingAggregate: 'compressed novel',
      chunkingCost: Number.NaN,
      eventCosts: [1, Number.NaN, 1],
    })

    const out = await meta.compose(
      { input: { prose: 'X'.repeat(2000), compressBeyond: 1000 } },
      ctx,
    )

    // The NaN chunking cost and the mid-loop NaN event are each guarded to 0
    // — a poisoned accumulator must not spread to later iterations' finite
    // costs. Only the two finite event calls (1 each) count.
    expect(Number.isFinite(out.cost)).toBe(true)
    expect(out.cost).toBe(2)
  })

  it('throws when the model returns malformed event JSON — no silent fallback', async () => {
    const meta = createNovelToEventsMeta()
    const ctx = {
      compute: <T>(_id: string, fn: () => Promise<T>) => fn(),
      step: async <T>(): Promise<T> =>
        ({
          modality: 'text',
          text: 'not json at all',
          cost: 1,
          latencyMs: 50,
          model: 'm',
          provider: 'p',
        }) as unknown as T,
    } as unknown as ExecutionContext

    await expect(
      meta.compose(
        { input: { prose: 'novel', compressBeyond: 0 } },
        ctx,
      ),
    ).rejects.toThrow()
  })

  it('declares a meta Pattern with stable id, kind, and agent-tool exposure', () => {
    const meta = createNovelToEventsMeta()
    expect(meta.id).toBe('meta_novel-to-events')
    expect(meta.kind).toBe('meta')
    expect(meta.namespace).toBe('meta-pipelines')
    expect(meta.exposure).toBe('agent-tool')
  })
})
