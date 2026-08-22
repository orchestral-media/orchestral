# incremental-rerun

A from-scratch host that submits a three-step meta pipeline, then submits it
again with **one input changed** — and watches the unchanged steps come back
from the `JobStore` under their **original child job ids**, in ~0 ms, with no
model call, while only the changed step and everything downstream of it re-run.
That is ComfyUI's node cache, for code, and nothing in this example implements
it: `src/main.ts` only observes what `InlineRuntime` already does.

**No API key.** The three models are hand-written mocks in
[`src/mock-models.ts`](./src/mock-models.ts) that sleep for 300–500 ms and
return schema-shaped outputs. This demo is about the runtime, not a provider.

## What it shows

[`src/pattern.ts`](./src/pattern.ts) declares `meta_short-clip`, input
`{ prompt, motion }`:

| step | pattern | reads |
| --- | --- | --- |
| `describe` | `text-generation` | `prompt` |
| `render` | `text-to-image` | step 1's text |
| `animate` | `image-to-video` | `motion` + step 2's still (via `PatternRef.assets`) |

Four runs in one session, one `InMemoryJobStore`:

1. **Run 1 — cold.** All three steps run. Four rows inserted.
2. **Run 2 — `motion` changed.** `describe` and `render` return in 0 ms under
   run 1's child job ids; `animate` re-runs on run 1's still (`img-1`).
3. **Run 3 — `prompt` changed.** Everything re-runs, all new ids.
4. **Run 4 — a second `InlineRuntime` over the same store.** It never ran
   `describe` or `render`, and still gets run 1's rows back for them.

## Run it

```sh
pnpm install
pnpm --filter incremental-rerun start
```

## Expected transcript

Ids differ per run (they are UUIDs, shown truncated); the shape does not.

```
Run 1 — cold
  input {"prompt":"a red bicycle","motion":"slow pan"}  →  meta job e6a7ba18 (done), 1207 ms across steps
  step      pattern           ms     childJobId  assets    
  describe  text-generation   303    5f59d85e              
  render    text-to-image     502    0558e637    img-1     
  animate   image-to-video    402    41dcc44c    clip-1    
  rows inserted this run: meta_short-clip, text-generation, text-to-image, image-to-video
  output: "Still of a red bicycle: centred in frame, soft morning light, shallow depth of field." → still img-1 → clip clip-1

Run 2 — same session, motion changed
  input {"prompt":"a red bicycle","motion":"orbit"}  →  meta job 930adc93 (done), 402 ms across steps
  step      pattern           ms     childJobId  assets    cached
  describe  text-generation   0      5f59d85e              yes — same childJobId as run 1, no row inserted
  render    text-to-image     0      0558e637    img-1     yes — same childJobId as run 1, no row inserted
  animate   image-to-video    402    e7aae9f2    clip-2    no  — new childJobId, row inserted
  rows inserted this run: meta_short-clip, image-to-video
  output: "Still of a red bicycle: centred in frame, soft morning light, shallow depth of field." → still img-1 → clip clip-2

Run 3 — prompt changed
  input {"prompt":"a blue kettle","motion":"orbit"}  →  meta job 64547677 (done), 1203 ms across steps
  step      pattern           ms     childJobId  assets    cached
  describe  text-generation   300    3b3683e3              no  — new childJobId, row inserted
  render    text-to-image     502    7b0cc0a1    img-2     no  — new childJobId, row inserted
  animate   image-to-video    401    325c16df    clip-3    no  — new childJobId, row inserted
  rows inserted this run: meta_short-clip, text-generation, text-to-image, image-to-video
  output: "Still of a blue kettle: centred in frame, soft morning light, shallow depth of field." → still img-2 → clip clip-3

Second runtime over the same store — abandonOrphanedJobs() found 0 row(s) mid-flight

Run 4 — second runtime, run 1 prompt, new motion
  input {"prompt":"a red bicycle","motion":"dolly zoom"}  →  meta job c5dfbb45 (done), 401 ms across steps
  step      pattern           ms     childJobId  assets    cached
  describe  text-generation   0      5f59d85e              yes — same childJobId as run 1, no row inserted
  render    text-to-image     0      0558e637    img-1     yes — same childJobId as run 1, no row inserted
  animate   image-to-video    401    80f75376    clip-4    no  — new childJobId, row inserted
  rows inserted this run: meta_short-clip, image-to-video
  output: "Still of a red bicycle: centred in frame, soft morning light, shallow depth of field." → still img-1 → clip clip-4

What made it work: each ctx.step derives its key from { patternId, input, assets, sessionId, stepIndex }
  (packages/orchestral-runtime/src/idempotency.ts) and goes through JobStore.insertIfAbsent, which hands
  back the existing done row on a hit — no dispatch, same childJobId, the stored output flows downstream.
What breaks it: a different sessionId. The key never crosses a session, so run 1's input in another
  session re-runs all three steps (pinned by the smoke test). Error / cancelled / stale rows never
  match either — a failed step always re-runs — and stepIndex is positional, so reordering compose is a
  new key too.
```

Registration prints nothing: the registry's `OUTPUTS_UNBOUNDED_FIELDS`
authoring lint is silent for the shipped atomics and for the meta in this
example alike, since both use the bounded vocabulary (`boundedText` /
`assetIdField` / `urlField`) for every string in their outputs schemas.

### How "cached" is decided

The runtime never sends a "cached" flag, and the example does not invent one.
The column is derived from two signals on the runtime's public surface
([`src/observe.ts`](./src/observe.ts)):

- **`job:step`** fires on the meta's own stream as each sub-step settles and
  carries `childJobId`, the sub-dispatch's row id. It fires for a dedup hit too
  (`meta-execution-context.ts` reports the step after `submitChild` returns,
  whichever way it returned), so on a hit the **same id shows up again**.
- **`InlineRuntimeInit.onJobCreated`** fires once per row the runtime INSERTs.
  A dedup hit inserts nothing, so it does not fire for that child — the
  "rows inserted this run" line is that hook's record.

`yes` means both agree (same id, no row); `no` means both agree the other way.
The `ms` column is the wall clock between consecutive `job:step` events.

## No key? The smoke test

```sh
pnpm --filter incremental-rerun test
```

[`src/__tests__/wiring.smoke.test.ts`](./src/__tests__/wiring.smoke.test.ts)
runs the same wiring with zero mock latency and pins:

- run 2's `describe` / `render` child ids equal run 1's and `animate` differs;
  run 3's all differ; and, via `vi.spyOn` on each mock's `call`, the models for
  steps 1–2 were called **exactly once** across runs 1–2;
- each child row's `idempotencyKey` equals `deriveIdempotencyKey({ patternId,
  input, assets, sessionId, stepIndex })` re-derived by hand (stepIndex 0/1/2);
- an identical re-submit dedupes the **whole meta** — same job id, no steps;
- a **different `sessionId`** re-runs everything (the boundary);
- a second runtime over the same store dedupes onto the first one's rows;
- a **failed step never dedupes**: after `animate` fails once, the retry
  re-dispatches it while `describe` / `render` still hit run 1's rows.

It also runs as part of the repo's `pnpm test`.

## Why this works

Every `ctx.step` inside a meta becomes a child `JobSpec`, and the runtime
derives its idempotency key in
[`packages/orchestral-runtime/src/idempotency.ts`](../../packages/orchestral-runtime/src/idempotency.ts)
from a hand-picked allowlist:

```
sha256({ patternId, input, assets, sessionId, stepIndex })
```

Routing metadata (`providerOptions`, `resolveHints`, `stepIdNamespace`, …) is
deliberately excluded. The child then goes through
`JobStore.insertIfAbsent` ([`packages/orchestral-core/src/job-store.ts`](../../packages/orchestral-core/src/job-store.ts),
implemented in [`job-store-memory.ts`](../../packages/orchestral-core/src/job-store-memory.ts)):
one atomic "dedup or create" that returns an existing `queued` / `running` /
`done` row for the key, or inserts the new one. On a hit, `ctx.step` receives
the existing row's stored output and nothing dispatches.

Three consequences the transcript relies on:

- **A step's input is its upstream's *stored* output.** `render`'s prompt is
  the text `describe` stored, so when `describe` is a hit, `render`'s key is
  byte-stable even if the real model behind `describe` is non-deterministic.
  `animate`'s still arrives through `PatternRef.assets` (the machine-to-machine
  asset channel in [`pattern-ref.ts`](../../packages/orchestral-core/src/pattern-ref.ts))
  and is folded into `assets` in its key — a new still is new work.
- **Explicit `stepId`s are for the host, not the key.** `describe` / `render`
  / `animate` are what `job:step` reports, so a host can line runs up by name.
  The key hashes `stepIndex` — the step's ordinal in `compose` — so the dedup is
  positional as well as content-addressed: insert a step ahead of `render` and
  `render` is a new key even with the same input. See the comment in
  [`src/pattern.ts`](./src/pattern.ts).
- **Only canonical rows dedupe.** `error` / `cancelled` / `stale` rows never
  match, so a failed step always re-runs; and the key includes `sessionId`, so
  dedup never crosses a session.

### Persistence

The runtime keeps no cache of its own — the store rows are the cache. Run 4
verifies that with a second `InlineRuntime` over the same `InMemoryJobStore`:
a fresh instance that never ran `describe` or `render` gets run 1's rows for
both. A host that injects a durable `JobStore` (SQLite, Postgres — the contract
is the same `insertIfAbsent`) should get the same behaviour across real process
restarts; that is expected from the contract, not demonstrated here, since no
durable store ships in this repo. `abandonOrphanedJobs()` is the other half of
the restart story: called on start, it marks rows a dead process left `queued`
/ `running` as `stale`, which — being non-canonical — never dedupe, so
interrupted work re-runs rather than returning a half-finished row.

## What's host territory vs. what ships in the box

- **`JobStore` and `CapabilityRouter`** are the zero-dependency defaults,
  `InMemoryJobStore` and `createDefaultCapabilityRouter`. Nothing to implement;
  the dedup lives in the store contract every host implementation must honour.
- **`ModelCapability.call`** is host territory. Here it is three mocks in
  [`src/mock-models.ts`](./src/mock-models.ts); in a real host it is the
  provider bridge `examples/atomic-hello-world` shows. The mocks mint a fresh
  asset id per call, so a hit is distinguishable from a re-render that happened
  to produce the same bytes.
- **The meta** is ordinary pattern-authoring: `ctx.step` via the typed
  `textGeneration` / `textToImage` / `imageToVideo` functions from
  `@orchestral/patterns`, with explicit step ids.
