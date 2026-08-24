import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PatternRegistry } from '../registry'
import {
  DEFAULT_AGENT_FINISH_SPEC,
  defaultAgentFinishOutputs,
} from '../agent-finish'
import { boundedText } from '../output-fields'
import type { AgentPattern } from '../pattern'
import { silentDiagnosticsLogger } from '../logger'

function makeAgent(over: Partial<AgentPattern>): AgentPattern {
  return {
    id: 'agent_t',
    kind: 'agent',
    description: 't',
    loop: { system: 's', toolPatternIds: [], modelTags: [] },
    ...over,
  } as AgentPattern
}

describe('agent finish registration rules', () => {
  it('backfills default finish trio when finish/outputs/extractor all absent', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    reg.register(makeAgent({}))
    const stored = reg.get('agent_t') as AgentPattern
    expect(stored.outputs).toBe(defaultAgentFinishOutputs)
    expect(stored.finish).toBe(DEFAULT_AGENT_FINISH_SPEC)
  })
  it('rejects finish + outputExtractor together', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(
        makeAgent({
          outputs: z.object({}),
          finish: DEFAULT_AGENT_FINISH_SPEC,
          loop: {
            system: 's', toolPatternIds: [], modelTags: [],
            outputExtractor: (t: string) => t,
          },
        }),
      ),
    ).toThrow(/AGENT_FINISH_EXTRACTOR_CONFLICT/)
  })
  it('rejects finish without outputs', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(makeAgent({ finish: DEFAULT_AGENT_FINISH_SPEC })),
    ).toThrow(/AGENT_FINISH_REQUIRES_OUTPUTS/)
  })
  it('rejects outputExtractor without outputs', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(
        makeAgent({
          loop: {
            system: 's', toolPatternIds: [], modelTags: [],
            outputExtractor: (t: string) => t,
          },
        }),
      ),
    ).toThrow(/AGENT_EXTRACTOR_REQUIRES_OUTPUTS/)
  })
  it('rejects custom outputs without finish (no way to produce them)', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(makeAgent({ outputs: z.object({ x: z.string() }) })),
    ).toThrow(/AGENT_OUTPUTS_REQUIRES_FINISH/)
  })
  it('accepts finish declared together with outputs', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(
        makeAgent({
          outputs: defaultAgentFinishOutputs,
          finish: DEFAULT_AGENT_FINISH_SPEC,
        }),
      ),
    ).not.toThrow()
  })
  it('accepts outputExtractor declared together with outputs', () => {
    const reg = new PatternRegistry({ logger: silentDiagnosticsLogger })
    expect(() =>
      reg.register(
        makeAgent({
          outputs: z.object({ x: z.string() }),
          loop: {
            system: 's', toolPatternIds: [], modelTags: [],
            outputExtractor: (t: string) => t,
          },
        }),
      ),
    ).not.toThrow()
  })
})

describe('outputs schema unbounded-field warning (non-fatal)', () => {
  // Deliberately BARE registries in this block: these tests assert the lint
  // reaches the DEFAULT logger (the console), and the vi.spyOn above each one
  // already keeps the output out of stderr. Injecting silentDiagnosticsLogger
  // here would silence the very thing under test.
  let warn: ReturnType<typeof vi.spyOn>
  afterEach(() => {
    warn.mockRestore()
  })

  it('warns on a bare z.string() output field, naming the pattern + field', () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = new PatternRegistry()
    reg.register(
      makeAgent({
        id: 'agent_unbounded',
        outputs: z.object({ blob: z.string() }),
        finish: DEFAULT_AGENT_FINISH_SPEC,
      }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OUTPUTS_UNBOUNDED_FIELDS (agent_unbounded): blob'),
    )
  })

  it('does not warn on a fully bounded outputs schema', () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = new PatternRegistry()
    reg.register(
      makeAgent({
        id: 'agent_bounded',
        outputs: z.object({ ok: boundedText(64) }),
        finish: DEFAULT_AGENT_FINISH_SPEC,
      }),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn for the backfilled default finish envelope (bounded)', () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = new PatternRegistry()
    reg.register(makeAgent({ id: 'agent_default' }))
    expect(warn).not.toHaveBeenCalled()
  })
})
