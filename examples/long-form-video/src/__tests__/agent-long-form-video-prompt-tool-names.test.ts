import { describe, expect, it } from 'vitest'

import {
  LONG_FORM_VIDEO_DIRECTOR_PROMPT,
  CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT,
} from '../patterns/agent-long-form-video/prompts'

// Host tools are registered under plain names (e.g. `concat_videos` /
// `complete_task`) — there is no `base.` prefix. These director prompts are
// LLM-facing instructions telling the agent which tool names to call; if
// they still say `base.concat_videos` / `base.complete_task`, the LLM will
// dispatch a tool name the host router (exact match, no prefix stripping)
// doesn't recognize. This package cannot import a host to check against its
// live tool registry, so this asserts the package-internal invariant only:
// no prompt text should carry the retired `base.` tool-name prefix.
const BASE_PREFIXED_TOOL_NAME = /\bbase\.[a-z_]+/

describe('agent_long-form-video prompts — no stale base. tool-name prefix', () => {
  it('director prompt does not reference base.-prefixed tool names', () => {
    expect(LONG_FORM_VIDEO_DIRECTOR_PROMPT).not.toMatch(BASE_PREFIXED_TOOL_NAME)
  })

  it('character-merge prompt does not reference base.-prefixed tool names', () => {
    expect(CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT).not.toMatch(
      BASE_PREFIXED_TOOL_NAME,
    )
  })
})
