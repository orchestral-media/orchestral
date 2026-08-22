# long-form-video

The reference **novel → multi-event video** pipeline: five planning metas and
the director agent that drives them, kept here as source under
[`src/patterns/`](./src/patterns) — not shipped in `@orchestral/patterns` or
`@orchestral/agent`. This host registers them next to the whole shipped
catalog and proves, with no API key, that the six compile and register against
the public `@orchestral/*` surface alone.

**No API key.** `start` registers the catalog and prints it; the tests drive
every `compose()` on a fake context, and one runs through the real
`InlineRuntime` on a scripted model. Nothing here dispatches a paid call.

## Why this is an example and not API

The six patterns were one pipeline with one consumer: `agent_long-form-video`
was the only thing that dispatched `meta_prose-chunking`,
`meta_novel-to-events` and `meta_event-to-script`, and `meta_idea2video` and
`meta_script-planning` were the same ViMax lineage with no other caller. On a
published surface every inlined prompt is a maintenance liability and a PR
magnet — each one is a wording argument waiting to happen, pinned by a
byte-equality test. The shipped catalog is now the seven metas a host actually
composes (`meta_image-best-of-n`, `meta_storyboard`, `meta_script2video`,
`meta_product-ad-short`, `meta_ugc-testimonial`, `meta_explainer-short`,
`meta_product-photo-pack`) plus the `via-caption` fallback; this example keeps
the long-form chain runnable and tested without making it something the
package has to keep stable.

The moved code is unchanged beyond what compiling outside the package
required: the relative imports of `_shared/meta-utils` and the atomic
`PatternFn`s became imports from `@orchestral/patterns`. That the six compile
this way is the point — the helpers they need are the package's authoring
surface, not its internals.

## What is here

| Pattern | What it does | Model calls per dispatch |
| --- | --- | --- |
| `meta_script-planning` | One-line idea → planned script. Routes to a narrative / motion / montage template, then expands. | 2 `text-generation` |
| `meta_prose-chunking` | Long prose → one compressed narrative. Host-side chunking, parallel compression, one aggregation. | 1 `text-generation` per chunk (∥) + 1 |
| `meta_novel-to-events` | Prose → causal chain of plot events. Nests `meta_prose-chunking` above `compressBeyond` chars. | 1 `text-generation` per event, sequential, ≤ `maxEvents` (default 50, cap 500) |
| `meta_event-to-script` | One event → ≤5 polished scene screenplays + an event-scope character registry. | 1 extraction + 1 character merge + 1 polish per scene (∥) |
| `meta_idea2video` | Idea → multi-scene video. Three text calls, a `ctx.askUser.form` script review, then `meta_script2video` per scene, then `concatVideos`. | 3 `text-generation` + N × `meta_script2video` + 1 host op |
| `agent_long-form-video` | The director: per event, `meta_event-to-script` → character merge (`text-generation`) → `meta_script2video` per scene; `meta_image-best-of-n` for weak frames; `concat_videos` at the end. | ~7 loop steps per event + ~10 framing |

The director and `meta_idea2video` both end in `meta_script2video`, which
ships in `@orchestral/patterns` and is registered here from the package like
everything else in [`src/catalog.ts`](./src/catalog.ts).

## Cost profile

Read this before wiring a key in. None of the six bounds its own spend; the
`ModelCapability` you register is where a budget ceiling goes.

- **The director is long by construction.** Roughly `maxEvents` × ~7 loop
  iterations plus ~10 for framing, every iteration a model call: at the
  schema's `maxEvents` cap of 500 a complete run is ~3500 steps. The agent
  declares no `stopWhen` — the step cap belongs to whoever runs the loop, and a
  cap sized for a chat turn does not stop a runaway, it truncates a legitimate
  run mid-novel. Its only checkpoint is the user cancelling.
- **Per scene, `meta_script2video` fans out hard.** Three portraits per
  visible character (front, then side and back off the front), then one first
  frame and one clip per shot, and with `transitionMode: 'between-shots'` a
  further N−1 transition clips — bounded by `maxShots` (default 12) and put
  to the user once per dispatch unless the caller passes
  `confirmBeforeRender: false`, which `meta_idea2video` does after its own
  form ask. An event yields up to five scenes. A fifty-event novel at three
  scenes per event and eight shots per scene is on the order of 150 × (3 ×
  characters + 16) paid image and video generations before the final concat.
- **`meta_idea2video` has one gate, then none.** The script-review form is the
  only `ctx.askUser` in the chain; after the user saves it, every scene
  renders. `meta_novel-to-events` and `meta_event-to-script` are text-only
  and cheap by comparison, but `meta_novel-to-events` is sequential — each
  event waits for the last — so its latency is `maxEvents` deep.

## The `concat_videos` host tool

Two different things, both on the host:

1. **`concatVideos`, the `MetaCommonDeps` op.** `meta_idea2video` (here) and
   `meta_script2video` (shipped) take it as a factory dependency, along with
   the other five ops the shipped deliverable metas Pick from.
   [`src/catalog.ts`](./src/catalog.ts) threads one `LongFormHostOps` object
   (the full `MetaCommonDeps`) into every factory that wants one.
2. **`concat_videos`, the agent tool.** The director's Stage 5 calls a tool by
   that name with `{ assetIds: [...handles] }` to stitch the scene videos. No
   package provides it: the host's `AgentRunImpl` grants it alongside the
   runtime's own `complete_task`, the way
   [`examples/agent-hello-world/src/agent-runner.ts`](../agent-hello-world/src/agent-runner.ts)
   builds its tool catalog. The smoke test pins that the prompt names it and
   that nothing in the registry answers to it.

Implement the concatenation once (ffmpeg or equivalent, plus asset storage)
and expose it twice.

## Run it

```sh
pnpm install
pnpm --filter long-form-video start   # no key: registers the catalog, prints it
pnpm --filter long-form-video test    # no key: every compose() on fakes, one through the runtime
```

`start` registers 24 patterns — the 18 from `@orchestral/patterns` and the six
from here — with host ops that refuse to be called, checks that every tool the
director names is registered, and prints the registry's authoring lint
verbatim (see below). A real run needs what this host does not ship: a
`CapabilityRouter` over your models, an `AgentRunImpl` that grants
`concat_videos`, a multimedia backend behind the six ops, and a step cap sized
to `maxEvents`.

## Tests

Everything the six had in their packages came along, plus one smoke test:

- [`catalog.smoke.test.ts`](./src/__tests__/catalog.smoke.test.ts) — registers
  everything with a recording logger; pins the 24 ids, the director's tool list
  resolving against the registry, `concat_videos` being a host tool and not a
  pattern, and the lint landing on the four text-producing long-form metas and
  nothing shipped.
- `meta-script-planning`, `meta-prose-chunking`, `meta-novel-to-events`,
  `meta-event-to-script`, `meta-idea2video`, `script-planning-wiring` — each
  meta's `compose()` on a fake `ExecutionContext`: prompt wiring, JSON parsing,
  fan-out, cost aggregation, the `idea2video` produced-assets envelope.
- `script-planning-dispatch-e2e` — `meta_script-planning` through a real
  `InlineRuntime` over an in-memory store and a scripted `text-generation`
  model: the compose body runs, sub-steps reach the atomic dispatcher, the
  inlined prompts arrive byte-for-byte, and a failing step settles the job in
  `error` with the original message.
- `agent-long-form-video`, `agent-long-form-video-prompt-tool-names` — the
  director's id, namespace, cache-stable system prefix, tool list, default
  finish envelope, and the absence of retired tool-name prefixes in its
  prompts.

They run as part of the repo's `pnpm test`.

## What the registry says about these patterns

`@orchestral/patterns` keeps every string in an outputs schema bounded
(`boundedText(n)`, `assetIdField()`, …), and `PatternRegistry` warns
`OUTPUTS_UNBOUNDED_FIELDS` at registration for any pattern that does not. The
long-form metas predate that vocabulary and moved here unchanged, so the four
that return text still carry bare `z.string()` fields — `plannedScript`,
`compressedChunks[]`, `aggregatedNarrative`, `events[].description`,
`eventScenes[].script`, and so on — and the registry says so: four
`OUTPUTS_UNBOUNDED_FIELDS` lines at registration, plus one
`OUTPUTS_UNAUDITED_FIELDS` line for `meta_event-to-script`'s free-form
`environment` record, which the audit cannot see into. (`meta_idea2video`
returns only the labelled `assets[]` envelope and a count, which is bounded
already; the agent declares no outputs of its own.) `start` prints the lines;
the smoke test pins that the flagged set is exactly those four and never a
shipped pattern. Bounding them is the first change to make if you take these
into a host of your own.

## Provenance

The prompt text in `src/patterns/*/prompts.ts` is derived from
[HKUDS/ViMax](https://github.com/HKUDS/ViMax) (MIT), with the one exception of
the director's own workflow prompt. [`CREDITS.md`](./CREDITS.md) lists the
constants and reproduces the upstream license.
