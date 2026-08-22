# Credits

`@orchestral/patterns` is licensed under Apache-2.0 (see `LICENSE`). Some of the
prompt text shipped in this package is derived from third-party work under a
different license. This file records that provenance.

## HKUDS/ViMax — MIT

The narrative video-production prompts in this package started as translations of
the agent prompts in [HKUDS/ViMax](https://github.com/HKUDS/ViMax). The pipeline
staging, the role/task framing, and several of the few-shot examples come from
that project; the JSON output contracts, the pattern wiring, and the surrounding
TypeScript are ours. Some few-shot examples have been rewritten — most notably,
the ViMax originals scripted lines for a named living person, and those roles are
now fictional characters.

Prompt constants derived from ViMax:

| File | Constants |
| --- | --- |
| `src/meta/script2video/prompts.ts` | `CHARACTER_EXTRACTION_PROMPT`, `PORTRAIT_FRONT_PROMPT`, `PORTRAIT_SIDE_PROMPT`, `PORTRAIT_BACK_PROMPT`, `SHOT_VISUAL_DECOMPOSITION_PROMPT`, `CAMERA_TREE_CONSTRUCTION_PROMPT`, `I2V_SHOT_TRANSITION_PROMPT` — `CINEMATIC_SHOT_FRAMING_PROMPT` and `I2V_SHOT_SINGLE_PROMPT` were rewritten as direct render prompts and no longer carry upstream text |
| `src/meta/_shared/storyboard-design-prompt.ts` | `STORYBOARD_DESIGN_PROMPT` (used by `meta_storyboard` and `meta_script2video`) |
| `src/meta/image-best-of-n/prompts.ts` | `BEST_OF_N_IMAGE_JUDGE_PROMPT` |

Not derived from ViMax: the short-form marketing prompts (`explainer-short`,
`product-ad-short`, `product-photo-pack`, `ugc-testimonial`).

The rest of the ViMax-derived prompts — the long-form novel → video pipeline
(script planning, idea-to-video, prose chunking, novel-to-events,
event-to-script, and the director's character-merge prompt) — left this
package and `@orchestral/agent` for `examples/long-form-video`, which carries
its own `CREDITS.md` for them. Nothing in `@orchestral/agent` derives from
ViMax any more.

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
