// meta_prose-chunking — MetaPattern. Composes the
// narrative-compression + narrative-aggregation skills.
//
// Compress a long-form prose passage (typically a novel chapter or
// multi-chapter span) into a condensed narrative ready for downstream
// event extraction or scene adaptation:
//   1. Host-side chunk split — paragraph-then-sentence-then-hard, capped at
//      `chunkTokenBudget` (token ≈ 4 chars heuristic).
//   2. Parallel per-chunk compression via text-generation with
//      narrative-compression SKILL.md as system.
//   3. One aggregation call via text-generation with narrative-aggregation
//      SKILL.md as system; prompt = ordered `<CHUNK_N_START>...<CHUNK_N_END>`
//      blocks (matches the aggregation SKILL's INPUT contract).
//
// `targetCompressionRatio` (optional) is woven into the compression prompt
// as a soft hint — the SKILL doesn't formally take a ratio input, so the
// hint is appended at the end of the user message. Honored as a guideline,
// not a hard cap.
//
// The 2 stage prompts are inlined as string constants in ./prompts (copied
// verbatim from the source SKILL.md bodies). This meta is self-contained for
// its prompts: no SkillLoader, no host binding for prompt loading.
//
// Exposure: 'agent-tool' — the chat catalog hides it; an agent reaches it
// via loop.toolPatternIds.

import { z } from 'zod'
import type { MetaPattern } from '@orchestral/core'
import { createPatternFn, metaEnvelopeShape, parallel } from '@orchestral/core'
import { textGeneration } from '../../atomic/text-generation'
import { resolvePrompts, sumCosts } from '../_shared/meta-utils'
import {
  NARRATIVE_COMPRESSION_PROMPT,
  NARRATIVE_AGGREGATION_PROMPT,
} from './prompts'

// ── input / output ──────────────────────────────────────────────────────

export const ProseChunkingInputSchema = z.object({
  prose: z
    .string()
    .min(1, 'prose required')
    .describe(
      'The long-form prose to compress. Typically a novel chapter or multi-chapter span; no upper length limit, but very large inputs spawn many parallel compression calls.',
    ),
  chunkTokenBudget: z
    .number()
    .int()
    .min(500)
    .max(64_000)
    .default(8_000)
    .optional()
    .describe(
      'Soft cap on the token count of each chunk (token estimated as ≈ 4 chars). Lower budgets mean more chunks + more parallel compression calls but smaller per-call prompts.',
    ),
  targetCompressionRatio: z
    .number()
    .min(0.05)
    .max(0.95)
    .optional()
    .describe(
      'Optional soft hint passed into the compression prompt — "aim for ~X% of the original length". The narrative-compression SKILL honors this as a guideline, not a hard cap.',
    ),
})
export type ProseChunkingInput = z.infer<typeof ProseChunkingInputSchema>

export const ProseChunkingOutputSchema = z.object({
  compressedChunks: z
    .array(z.string())
    .readonly()
    .describe(
      'Per-chunk compressed text in submission order. Length equals the number of chunks the input split into; preserved for downstream RAG / debug.',
    ),
  aggregatedNarrative: z
    .string()
    .describe(
      'Single coherent compressed narrative produced by stitching the per-chunk compressions via narrative-aggregation.',
    ),
  cost: metaEnvelopeShape.cost.describe(
    'USD cost summed across all per-chunk compress calls + 1 aggregate call.',
  ),
  latencyMs: metaEnvelopeShape.latencyMs
    .int()
    .min(0)
    .describe(
      'Wall-clock latency: max(parallel chunk compress latencies) + aggregate latency.',
    ),
})
export type ProseChunkingOutput = z.infer<typeof ProseChunkingOutputSchema>

export const PROSE_CHUNKING_PATTERN_ID = 'meta_prose-chunking'

/** Typed `ctx.step` sugar — dispatch this meta from another meta's compose(). */
export const proseChunkingMeta = createPatternFn<
  ProseChunkingInput,
  ProseChunkingOutput
>(PROSE_CHUNKING_PATTERN_ID)

// ── factory ──────────────────────────────────────────────────────────────

/**
 * @alpha
 * Default system prompts for meta_prose-chunking (per-chunk compression +
 * final aggregation). Consumers override via `ProseChunkingMetaInit.prompts`;
 * unset keys fall back to these.
 */
export const PROSE_CHUNKING_DEFAULT_PROMPTS = Object.freeze({
  narrativeCompression: NARRATIVE_COMPRESSION_PROMPT,
  narrativeAggregation: NARRATIVE_AGGREGATION_PROMPT,
})

/** @alpha Per-step prompt overrides for meta_prose-chunking. */
export type ProseChunkingPromptOverrides = Partial<
  Record<keyof typeof PROSE_CHUNKING_DEFAULT_PROMPTS, string>
>

/** @alpha Optional init for meta_prose-chunking (prompt overrides only). */
export type ProseChunkingMetaInit = {
  prompts?: ProseChunkingPromptOverrides
}

/** @alpha */
export function createProseChunkingMeta(
  init: ProseChunkingMetaInit = {},
): MetaPattern<ProseChunkingInput, ProseChunkingOutput> {
  const resolved = resolvePrompts(PROSE_CHUNKING_DEFAULT_PROMPTS, init.prompts)
  return {
    id: PROSE_CHUNKING_PATTERN_ID,
    kind: 'meta',
    searchHint:
      'compress and stitch a long prose passage or novel chapter into a condensed narrative',
    namespace: 'meta-pipelines',
    exposure: 'agent-tool',
    description:
      'Compress a long-form prose passage (novel chapter / multi-chapter span) into a condensed coherent narrative. Splits the prose into token-budgeted chunks, compresses each chunk in parallel via the narrative-compression skill, then aggregates the per-chunk compressions into a single seamless story via the narrative-aggregation skill.',
    tool: {
      description:
        'Compress and stitch a long prose passage (novel chapter, multi-chapter span, or any extended narrative) into a condensed coherent short story. Use when downstream needs the gist of long-form prose without the original length — e.g. before event extraction, before RAG retrieval into a budget-constrained context, or to fit a hours-long source into a single LLM call.',
      inputs: ProseChunkingInputSchema,
    },
    outputs: ProseChunkingOutputSchema,
    async compose(params, ctx): Promise<ProseChunkingOutput> {
      const { input } = params

      // Stage 1 — host-side chunk split. Token ≈ 4 chars heuristic; we split
      // on paragraph boundaries first, fall back to sentence, then hard
      // character cut. See `splitProseByTokenBudget` below.
      const chunks = splitProseByTokenBudget(
        input.prose,
        input.chunkTokenBudget ?? 8_000,
      )

      // Stage 2 — compress each chunk in parallel. The compression SKILL
      // expects `<NOVEL_CHUNK_START>...<NOVEL_CHUNK_END>` and we may append
      // a soft `targetCompressionRatio` hint to the user message. The
      // compression prompt (inlined, byte-identical to the SKILL.md) is the
      // system slot.
      const ratioHint =
        input.targetCompressionRatio !== undefined
          ? `\n\n(Compression target: aim for ~${Math.round(input.targetCompressionRatio * 100)}% of the original chunk length.)`
          : ''

      const compressed = await parallel(
        chunks.map((chunk, idx) =>
          textGeneration(
            ctx,
            {
              system: resolved.narrativeCompression,
              prompt: `<NOVEL_CHUNK_START>\n${chunk}\n<NOVEL_CHUNK_END>${ratioHint}`,
            },
            { stepId: `compress-${idx}` },
          ),
        ),
      )

      // Stage 3 — aggregate in one shot. The aggregation SKILL expects
      // ordered `<CHUNK_N_START>...<CHUNK_N_END>` blocks; its inlined prompt
      // is the system slot.
      const aggregated = await textGeneration(ctx, {
        system: resolved.narrativeAggregation,
        prompt: buildAggregationPrompt(compressed.map((c) => c.text)),
      })

      const compressCost = sumCosts(...compressed)
      const compressLatencyMs = compressed.reduce(
        (max, c) => Math.max(max, c.latencyMs),
        0,
      )

      return {
        compressedChunks: compressed.map((c) => c.text),
        aggregatedNarrative: aggregated.text,
        cost: sumCosts({ cost: compressCost }, aggregated),
        latencyMs: compressLatencyMs + aggregated.latencyMs,
      }
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Heuristic chunker: try to keep paragraph boundaries; fall back to
 * sentence boundaries; finally hard-cut on character index.
 *
 * Token count is script-aware:
 *   - CJK (Chinese / Japanese / Korean) tokenizers commonly produce ~1
 *     token per character, sometimes 1.5 for compound BPE words. We use
 *     `chars / 1.5` for the CJK portion to stay under the budget rather
 *     than over.
 *   - English / Latin tokenizers cluster around 1 token per 4 chars
 *     (the canonical approximation used across modern tokenizers).
 *   - Mixed scripts: estimate per-portion and weighted-average so a
 *     half-Chinese-half-English chapter doesn't get charged at either
 *     extreme.
 *
 * The output is per-script char budget — i.e. we set `charBudget` to
 * whatever character count the input's script mix can fit under
 * `tokenBudget` tokens (best-effort underestimate of capacity, not
 * overestimate, so we stay safely inside provider context windows).
 *
 * Returns at least one chunk even for empty input (the caller already
 * gates on prose.min(1), so this just keeps the contract clean).
 */
export function splitProseByTokenBudget(
  prose: string,
  tokenBudget: number,
): readonly string[] {
  const charBudget = estimateCharBudget(prose, tokenBudget)
  if (prose.length <= charBudget) return [prose]

  // Phase 1: split on blank-line-separated paragraphs, accumulate into
  // chunks until we approach charBudget.
  const paragraphs = prose.split(/\n\s*\n/)
  const chunks: string[] = []
  let buf = ''
  for (const p of paragraphs) {
    const trimmed = p.trim()
    if (trimmed.length === 0) continue
    if (buf.length === 0) {
      buf = trimmed
    } else if (buf.length + trimmed.length + 2 <= charBudget) {
      buf += '\n\n' + trimmed
    } else {
      chunks.push(buf)
      buf = trimmed
    }
    // Phase 2: a single paragraph longer than the budget needs deeper
    // splitting. Fall through to sentence-then-hard.
    while (buf.length > charBudget) {
      const cut = sentenceOrHardCut(buf, charBudget)
      chunks.push(buf.slice(0, cut).trim())
      buf = buf.slice(cut).trim()
    }
  }
  if (buf.length > 0) chunks.push(buf)
  return chunks
}

/**
 * Pick the position to cut a chunk that exceeds budget. Prefer the latest
 * sentence boundary (`. ` / `! ` / `? ` plus their full-width CJK
 * counterparts) inside `[budget/2, budget]`; fall back to budget itself
 * for a hard cut. Returning at most `budget` guarantees forward progress.
 */
function sentenceOrHardCut(s: string, budget: number): number {
  // Anchor the search window in the second half of the budget so we don't
  // shrink chunks too aggressively when one long sentence dominates.
  const winStart = Math.floor(budget / 2)
  let best = -1
  for (let i = winStart; i < Math.min(budget, s.length); i++) {
    const ch = s[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？') {
      // Prefer cuts followed by whitespace or end-of-string; CJK punctuation
      // is normally not followed by a space.
      const next = s[i + 1]
      if (next === undefined || /\s/.test(next) || ch === '。' || ch === '！' || ch === '？') {
        best = i + 1
      }
    }
  }
  return best > 0 ? best : Math.min(budget, s.length)
}

function buildAggregationPrompt(chunks: readonly string[]): string {
  return chunks
    .map((c, i) => `<CHUNK_${i}_START>\n${c}\n<CHUNK_${i}_END>`)
    .join('\n\n')
}

// CJK script ranges — Chinese (CJK Unified), Japanese (Hiragana, Katakana,
// half-width Katakana, CJK Compat), Korean (Hangul Syllables). Quick char
// classification is enough — full Unicode normalization would gain at most
// a few percent accuracy and we're already a heuristic.
const CJK_RE =
  /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/

function estimateCharBudget(prose: string, tokenBudget: number): number {
  // Sample first ~2000 chars for script mix detection — that's a cheap
  // O(1) check vs scanning the entire potentially huge input. The first
  // few KB are highly representative of the script mix of the whole work
  // for natural-language prose.
  const sampleLen = Math.min(prose.length, 2000)
  let cjkChars = 0
  for (let i = 0; i < sampleLen; i++) {
    if (CJK_RE.test(prose[i]!)) cjkChars++
  }
  const cjkRatio = sampleLen > 0 ? cjkChars / sampleLen : 0
  // Chars per token: CJK ~ 1.5, Latin/etc ~ 4. Weighted blend.
  const charsPerToken = cjkRatio * 1.5 + (1 - cjkRatio) * 4
  return Math.floor(tokenBudget * charsPerToken)
}
