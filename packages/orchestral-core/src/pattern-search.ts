// The retrieval seam.
//
// `FindPatternInputSchema` is the wire contract for a find_pattern CALL; this
// is the contract for whatever ANSWERS one. Core describes it and ships no
// implementation, for the same reason it ships no provider SDK and no agent
// loop: which algorithm turns a free-form query into a shortlist is a product
// decision a host may want to replace (BM25, embeddings, a hosted search
// service, a hand-written router), and it drags in a search dependency core
// must not carry. @orchestral/discovery ships the first-party BM25 one behind
// `createPatternSearch`.

import type { ResolveContext } from './capability-model'
import type { FindPatternInput } from './find-pattern-schema'

/**
 * One find_pattern call plus the corpus scoping its caller owns.
 *
 * Everything except `input` belongs to the caller, not to the model: a scoped
 * agent loop hands over its own allowlist and cycle-defence sets, and an
 * implementation MUST honour them. They are what keeps a loop inside its
 * declared `loop.toolPatternIds` — the model can neither see nor widen them,
 * and a search that ignores them hands back Patterns the dispatch guard will
 * only refuse one round-trip later.
 */
export interface PatternSearchRequest {
  /** The validated find_pattern input, exactly as the model wrote it. */
  input: FindPatternInput
  /**
   * Which catalog surface asked. `'agent-loop'` must surface
   * `exposure: 'agent-tool'` Patterns (fine-grained primitives meant only for
   * agent loops); `'chat-turn'` must hide them.
   */
  audience: 'chat-turn' | 'agent-loop'
  /** When present, only these Pattern ids may be returned. */
  includeOnly?: ReadonlySet<string>
  /** Ids that must never be returned — cycle defence and blocklist matches. */
  excludeIds?: ReadonlySet<string>
  /**
   * Ids the caller already exposes as DIRECT tools. They sit outside
   * `includeOnly` by design; an implementation that can answer "you already
   * hold that one" spares the model a synonym hunt for a tool it has.
   */
  directToolIds?: ReadonlySet<string>
  /**
   * The dispatch's ResolveContext, for an implementation that drops Patterns
   * no model can serve. Satisfiability filtering is the implementation's
   * choice, not this contract's: it needs a `CapabilityRouter`, which the host
   * already holds and this request does not carry.
   */
  resolveCtx?: ResolveContext
}

/**
 * Answer a find_pattern call.
 *
 * The resolved value is handed to the model verbatim as the tool result, so
 * its shape is the implementation's contract with the model rather than
 * core's — nothing here parses or validates it. `FindPatternResult` in
 * @orchestral/discovery is the first-party shape. The caller awaits the
 * value, so an implementation that goes out to a hosted search may return a
 * promise.
 */
export type PatternSearch = (req: PatternSearchRequest) => unknown
