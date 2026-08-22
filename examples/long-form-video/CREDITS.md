# Credits

This example is licensed under Apache-2.0 with the rest of the Orchestral
monorepo (see the repo `LICENSE`). Most of the prompt text under
`src/patterns/` is derived from third-party work under a different license.
This file records that provenance; it came along with the prompts when they
left `@orchestral/patterns` and `@orchestral/agent` for this example.

## HKUDS/ViMax — MIT

The narrative video-production prompts here started as translations of the
agent prompts in [HKUDS/ViMax](https://github.com/HKUDS/ViMax). The pipeline
staging, the role/task framing, and several of the few-shot examples come from
that project; the JSON output contracts, the pattern wiring, and the
surrounding TypeScript are ours. Some few-shot examples have been rewritten —
most notably, the ViMax originals scripted lines for a named living person, and
those roles are now fictional characters.

Prompt constants derived from ViMax:

| File | Constants |
| --- | --- |
| `src/patterns/script-planning/prompts.ts` | `SCRIPT_INTENT_ROUTING_PROMPT`, `NARRATIVE_SCRIPT_PLANNING_PROMPT`, `MOTION_SCRIPT_PLANNING_PROMPT`, `MONTAGE_SCRIPT_PLANNING_PROMPT` |
| `src/patterns/idea2video/prompts.ts` | `STORY_DEVELOPMENT_PROMPT`, `CHARACTER_EXTRACTION_PROMPT`, `SCRIPT_WRITING_PROMPT` |
| `src/patterns/prose-chunking/prompts.ts` | `NARRATIVE_COMPRESSION_PROMPT`, `NARRATIVE_AGGREGATION_PROMPT` |
| `src/patterns/novel-to-events/prompts.ts` | `NEXT_EVENT_EXTRACTION_PROMPT` |
| `src/patterns/event-to-script/prompts.ts` | `NEXT_SCENE_EXTRACTION_PROMPT`, `CHARACTER_MERGE_SCENE_TO_EVENT_PROMPT`, `SCRIPT_ENHANCEMENT_PROMPT` |
| `src/patterns/agent-long-form-video/prompts.ts` | `CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT` |

Not derived from ViMax: `LONG_FORM_VIDEO_DIRECTOR_PROMPT` (the director's own
workflow).

The storyboard-design prompt these pipelines rely on through
`meta_script2video` stays in `@orchestral/patterns`, which carries its own
`CREDITS.md` for it and the other ViMax-derived constants that still ship.

### License

The ViMax `LICENSE` file, reproduced verbatim. It carries no named copyright
holder beyond the year.

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
