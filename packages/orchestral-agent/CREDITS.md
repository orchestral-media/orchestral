# Credits

`@orchestral/agent` is licensed under Apache-2.0 (see `LICENSE`). Some of the
prompt text shipped in this package is derived from third-party work under a
different license. This file records that provenance.

## HKUDS/ViMax — MIT

One embedded SKILL body in this package started as a translation of an agent
prompt in [HKUDS/ViMax](https://github.com/HKUDS/ViMax). The role/task framing
and the merge-instruction shape come from that project; the JSON output
contract, the pattern wiring, and the surrounding TypeScript are ours.

Prompt constants derived from ViMax:

| File | Constants |
| --- | --- |
| `src/long-form-video/prompts.ts` | `CHARACTER_MERGE_EVENT_TO_NOVEL_PROMPT` |

Not derived from ViMax: `LONG_FORM_VIDEO_DIRECTOR_PROMPT` and
`ORCHESTRATOR_SYSTEM_PROMPT`.

The sibling `@orchestral/patterns` package carries its own `CREDITS.md` for the
meta-pipeline prompts derived from the same project.

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
