# consented-fallback

A from-scratch host whose catalog has a `text-to-image` model and an
`image-to-text` model and **no `image-to-image` model** — and the user wants to
edit a picture. In thirty seconds of terminal output it shows the three things
Orchestral does about that gap that a router alone cannot:

1. **Semantic fallback is declared data, with its losses stated.**
   `image-to-image` ships one `Alternative`, `via-caption`: caption the source
   with `image-to-text`, re-render it with `text-to-image`. Its declaration
   says what survives (`preserves: ['style']`) and what does not
   (`losses: ['subject-identity', 'composition', 'mask-guidance']`).
2. **The runtime does not take that path on its own.** `InlineRuntime`
   defaults to `alternatives: 'off'`: the dispatch fails with
   `ALTERNATIVES_NOT_ENABLED` and the applicable paths named on
   `JobError.details.diagnostic`. With `alternatives: 'auto'` it redirects and
   announces the degradation as a `job:alternative-selected` event carrying
   the `losses`.
3. **A human can be asked.** The example's own `meta_consented-edit`
   ([`src/consented-edit.ts`](./src/consented-edit.ts)) calls
   `ctx.askUser.confirm(...)` — compose() parks until the host's
   `AskUserHandler` answers — and only on yes dispatches the declared path
   through `ctx.step`, with the same `mapInput` / `mapOutput` the runtime
   would have used.

Plus a beat on `router.explain` + `formatRoutingExplanation`: the routing
decision as data, printed as a `--dump-config`-style block.

The whole host is [`src/main.ts`](./src/main.ts) (the narrative), the two
`ModelCapability` envelopes in [`src/ai-sdk-wiring.ts`](./src/ai-sdk-wiring.ts),
a Map-backed [`src/asset-store.ts`](./src/asset-store.ts), and the meta. There
is zero host engine code.

## Run it

Offline, on `ai/test` mock models — no key:

```sh
pnpm install
pnpm --filter consented-fallback start          # answer y or n at the prompt
printf 'y\n' | pnpm --filter consented-fallback start   # non-interactive
```

The question in step 3 is read from stdin; a closed stdin (`< /dev/null`)
reads as "no".

Against real OpenAI models (`gpt-image-1` for rendering, `gpt-4o` for the
caption), same narrative:

```sh
export OPENAI_API_KEY=sk-...
SOURCE_IMAGE=./some-picture.png pnpm --filter consented-fallback start:live
```

`SOURCE_IMAGE` replaces the embedded 1x1 PNG in either mode. `--live` is the
only difference between the two runs: it swaps the two model instances and
imports `@ai-sdk/openai` on that branch alone.

## Expected transcript

`printf 'y\n' | pnpm --filter consented-fallback start`, stdout:

```
consented-fallback — the user wants to edit a picture ("make it night, keep the bicycle"), and the catalog has no image-to-image model.
  text-to-image  mock:mock-image (by first-candidate)
  image-to-text  mock:mock-vlm (by first-candidate)
  image-to-image no model (no-model-in-catalog)

── 1. explain — why image-to-image has no model ────────────────────────────
routing: image-to-image
satisfiable: no (no-model-in-catalog)
resolve: throws NO_MODEL_FOR_CAPABILITY (no-model-in-catalog)
context: (none)
ranking: declared order (getModels)
candidates: 0 kept of 0

── 2. default — the runtime refuses, and names the path it did not take ────
submitJob(image-to-image) -> status=error code=ALTERNATIVES_NOT_ENABLED
  reason: no-model-in-catalog — 1 declared path(s) would have applied, none taken:
    via-caption -> meta_image-to-image-via-caption
      keeps: style. loses: subject identity, composition, mask guidance.
  hint: Construct InlineRuntime with `alternatives: 'auto'` to let it redirect through declared alternatives automatically, or submit one of the listed targetPatternId values yourself.

── 3. ask — a meta puts the trade-off to a human before taking it ──────────
submitJob(meta_consented-edit)
  ? No image-to-image model. Take the 'via-caption' path instead?
    No image-to-image model is available: caption the source image, then re-render it from that caption plus the edit instruction. Subject identity and composition are lost, and a mask is ignored — the whole frame is regenerated.
    Keeps: style. Loses: subject identity, composition, mask guidance.
    [y/N] 
  -> yes
  step image-to-text settled
  step text-to-image settled -> 1 asset(s)
  step meta_image-to-image-via-caption settled -> 1 asset(s)
status=done outcome=edited degraded=true
  img-1 — data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFc…

── 4. auto — a second runtime, built with alternatives: 'auto' ─────────────
submitJob(image-to-image)
  event job:alternative-selected — via-caption -> meta_image-to-image-via-caption
    keeps: style. loses: subject identity, composition, mask guidance.
  step image-to-text settled
  step text-to-image settled -> 1 asset(s)
status=done via mock:mock-image
  img-2 — data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFc…
  the output is image-to-image's own shape; the degradation travelled on the event above, not in it
```

Answer `n` (or close stdin) and step 3 ends instead with:

```
    [y/N] 
  -> no (stdin closed)
status=done outcome=declined degraded=false
  nothing was dispatched
```

Registration prints nothing to **stderr**: the registry's
`OUTPUTS_UNBOUNDED_FIELDS` authoring lint is silent for the shipped atomics,
whose outputs use the bounded vocabulary, and the example's own meta declares
a bounded output too.

## What each step is reading

- **Step 1** is `router.explain('image-to-image')`, rendered by
  `formatRoutingExplanation`. The same screening `resolve` runs — every
  candidate `getModels` returned and the filter that dropped it, then what
  `resolve` would do — with nothing called. Here the list is empty because the
  host's `getModels` has no image-to-image entry, which is the point.
- **Step 2** reads the failed job row `submitJob` resolves with. A dispatch
  that ran and failed is data (see `Runtime.submitJob` in `@orchestral/core`):
  the row is written with its `JobError`, `job:failed` fires, and the promise
  resolves with that row — nothing to catch.
  `error.details.diagnostic` names the capability, the reason, and every
  applicable path by `id` / `description` / `targetPatternId` — and carries
  each path's `preserves` / `losses` verbatim, which is what the `keeps` /
  `loses` line prints. The refusal hands the host the trade-off; it does not
  send it back to the registry to look the path up by id.
- **Step 3** is the example's meta. `createConsentedEditPattern({ path })` is
  handed the `Alternative` image-to-image declares, and everything it does
  comes from it: the question is the declaration's `description` plus its
  `preserves` / `losses` spelled out; on yes, `ctx.step` dispatches
  `path.via.patternId` with `path.via.mapInput(input)`, the source image
  forwarded on the internal asset channel (`PatternRef.assets`), and
  `path.via.mapOutput` projects the result back. Nothing in the meta names
  `meta_image-to-image-via-caption`. The `step …` lines are `job:step` events:
  every sub-step in the tree settles on the root job's stream, so the nested
  chain is visible from the one job that was submitted. No
  `job:alternative-selected` fires — the host took the path, the runtime did
  not.
- **Step 4** is the same `image-to-image` dispatch on a runtime built with
  `alternatives: 'auto'`. The runtime picks `via-caption` itself and fans out
  `job:alternative-selected` with the `losses` *before* the redirect runs. The
  output is image-to-image's own shape, with no `degraded` flag — the
  declaration's `mapOutput` drops it on purpose, because the event is the
  notice.

## No key? Run the smoke test

```sh
pnpm --filter consented-fallback test
```

[`src/__tests__/wiring.smoke.test.ts`](./src/__tests__/wiring.smoke.test.ts)
runs the same registry → router → runtime wiring on the same mocks, with the
stdin handler replaced by one that auto-answers. It pins every beat: the
explanation reports `no-model-in-catalog`; the default runtime fails with
`ALTERNATIVES_NOT_ENABLED` naming `via-caption` and calls no model; a yes
runs the caption step **on the source image** (the mock VLM records the PNG
bytes it was sent) and the render step at via-caption's draft size; a no
declines with nothing dispatched; `'auto'` fires the event with the losses
and completes in image-to-image's shape. It also runs as part of the repo's
`pnpm test`.

## What's host territory vs. what ships in the box

- **`JobStore` and `CapabilityRouter`** are the zero-dependency defaults
  (`InMemoryJobStore`, `createDefaultCapabilityRouter`).
- **`ModelCapability.call`** — two envelopes in
  [`src/ai-sdk-wiring.ts`](./src/ai-sdk-wiring.ts), both from
  `@orchestral/adapters-ai-sdk`: `fromImageModel` for text-to-image, its
  `mintAssetId` hook recording each produced image into the host store and
  putting the store's id on the output, and `fromVisionModel` for
  image-to-text, its `loadImage` hook answering from the same store. The core
  packages ship neither SDK; the example installs `ai@^7` and `@ai-sdk/openai`
  itself.
- **Asset bytes** — [`src/asset-store.ts`](./src/asset-store.ts). Orchestral
  passes media between steps as assetIds and never reads or writes bytes; the
  two adapter hooks are where ids and bytes meet — `mintAssetId` stores what
  text-to-image produced and mints its id, `loadImage` turns a `ctx.assets`
  id back into bytes — and both are answered from this store.
- **`AskUserHandler`** — `askOnStdin` in `main.ts`. The runtime hands it an
  `AskUserRequest`; `kind` names the interaction and the payload / answer
  shapes per kind are the schemas in core's `ask-user.ts`
  (`AskUserConfirmPayloadSchema` → `{ confirmed }`). How it is rendered is the
  host's choice; the park lives in memory and does not survive a restart.
