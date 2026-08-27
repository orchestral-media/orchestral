// find_pattern — the LLM-facing input contract.
//
// The schema lives here rather than with the handler because it is a wire
// contract, not a search implementation: `buildCatalogDescriptors` serialises
// it into the fixed `find_pattern` tool definition (the KV-cache-stable prefix)
// and a host validates an incoming tool call against it before dispatching.
// Both are core concerns and neither needs a search index — exactly the split
// `dispatch-pattern.ts` already makes for `dispatch_pattern`.
//
// The retrieval that answers a validated call — the BM25 index and the
// `handleFindPattern` handler — ships in `@orchestral/discovery`, so the
// describe text below stays implementation-neutral: a query mini-language
// (mandatory terms, selectors) is the retrieval implementation's to advertise,
// through `BuildCatalogDescriptorsOptions.querySyntaxHint`. Core describing a
// syntax it does not parse is a drift only human eyes can catch.

import { z } from 'zod'

/** LLM-facing input contract for the find_pattern catalog tool. */
export const FindPatternInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      [
        'Free-form description of the task you need a Pattern for.',
        'Examples: "describe image content", "replace person with cyberpunk style", "transcribe podcast to subtitles".',
      ].join(' '),
    ),
  kind: z
    .enum(['atomic', 'meta', 'agent'])
    .optional()
    .describe(
      'Optional Pattern kind filter. atomic = single capability call; meta = multi-step pipeline; agent = LLM-driven loop. Omit to search all kinds.',
    ),
  modality: z
    .enum(['image', 'video', 'audio', 'text'])
    .optional()
    .describe(
      'Optional modality filter (only meaningful for kind=atomic). Atomic Patterns are grouped by namespace: image-gen / video-gen / audio-gen / text-gen.',
    ),
})
export type FindPatternInput = z.infer<typeof FindPatternInputSchema>
