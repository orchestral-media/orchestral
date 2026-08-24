# plan-short-clip

The same three-step pipeline [`examples/incremental-rerun`](../incremental-rerun)
hand-writes as a `compose()`, here written as **data**:
[`src/short-clip.plan.json`](./src/short-clip.plan.json) is the whole pipeline,
and [`planToMeta`](../../packages/orchestral-patterns/src/meta/plan/index.ts)
walks it with the registry in hand and returns an ordinary `MetaPattern`.
Nothing about the runtime knows it is a plan — `origin: 'plan'` records where it
came from, and nothing gates on it.

**No API key.** The three models are hand-written mocks in
[`src/mock-models.ts`](./src/mock-models.ts) that sleep for 300–500 ms and
return schema-shaped outputs. This demo is about the interpreter and the
runtime, not a provider.

## The plan

```json
{
  "steps": [
    { "id": "describe", "pattern": "text-generation",
      "input": { "system": "You are a cinematographer. …", "prompt": "$input.prompt" } },
    { "id": "render",   "pattern": "text-to-image",
      "input": { "prompt": "$describe.text" } },
    { "id": "animate",  "pattern": "image-to-video",
      "input": { "prompt": "$input.motion" },
      "assets": { "startFrame": "$render.assets[0]" } }
  ],
  "output": {
    "assets": [ { "from": "$animate.assets[0]", "label": "clip" } ],
    "values": { "description": "$describe.text" }
  }
}
```

A `$ref` is a **path, not an expression**: no interpolation, no arithmetic, no
conditionals. `"$describe.text"` as a whole string is replaced by that field of
what `describe` returned; `"Animate: $describe.text"` is a literal, and the walk
says so rather than letting you pay for it. Media never travels through `input`
— `assets` binds it to the target's declared reference slot, which is the only
channel that can carry a step's own product.

`$input` binds to the factory's own `inputs` schema
([`src/pattern.ts`](./src/pattern.ts)): `{ prompt, motion }`. That schema is
also the pattern's `tool.inputs`, so the plan is callable like any other meta.

## What it shows

Three runs in one session, one `InMemoryJobStore`:

1. **Run 1 — cold.** All three steps run. Four rows inserted.
2. **Run 2 — `motion` changed.** `describe` and `render` never read
   `$input.motion`, so their keys are unchanged: both come back under run 1's
   child job ids with no model call, and `animate` re-runs on run 1's still.
   This half is exactly what the hand-written twin shows — *a plan is a meta*,
   and it gets the meta engine's content-addressed dedup unchanged.
3. **Run 3 — the plan revised, a `caption` step inserted second.** All three
   original steps still hit. **One model call for one new step.**

Run 3 is the part a hand-written meta does not get. Every plan step dispatches
with `identity: 'id'`
([`StepOptions.identity`](../../packages/orchestral-core/src/execution-context.ts)),
so its durable row is keyed by the step's **name** rather than by its position
in the compose run:

```
key = sha256({ patternId, input, assets, sessionId, stepKey: 'render' })
```

Under the positional default, inserting `caption` second would move `render`
from index 1 to 2 and `animate` from 2 to 3 — a new key for each, and two paid
re-runs of work whose inputs did not change. That is the cost
`examples/incremental-rerun/src/pattern.ts` names in its own comments, and it is
the cost a model-edited pipeline would pay on **every** revision.

## Run it

```sh
pnpm install
pnpm --filter plan-short-clip start
```

## Expected transcript

Ids differ per run (they are UUIDs, shown truncated); the shape does not.

```
Run 1 — cold
  input {"prompt":"a red bicycle","motion":"slow pan"}  →  plan job ef38f85a (done), 1217 ms across steps
  step      pattern           ms     childJobId  assets
  describe  text-generation   306    25e4e291
  render    text-to-image     505    cdb6b5e7    img-1
  animate   image-to-video    406    215a82bd    clip-1
  rows inserted this run: meta_short-clip, text-generation, text-to-image, image-to-video

Run 2 — same session, motion changed
  step      pattern           ms     childJobId  assets    cached
  describe  text-generation   2      25e4e291              yes — same childJobId as run 1, no row inserted
  render    text-to-image     1      cdb6b5e7    img-1     yes — same childJobId as run 1, no row inserted
  animate   image-to-video    403    8d77d426    clip-2    no  — new childJobId, row inserted
  rows inserted this run: meta_short-clip, image-to-video

Run 3 — a step inserted second
  step      pattern           ms     childJobId  assets    cached
  describe  text-generation   3      25e4e291              yes — same childJobId as run 1, no row inserted
  caption   text-generation   303    51010123              no  — new childJobId, row inserted
  render    text-to-image     0      cdb6b5e7    img-1     yes — same childJobId as run 1, no row inserted
  animate   image-to-video    1      215a82bd    clip-1    yes — same childJobId as run 1, no row inserted
  rows inserted this run: meta_short-clip-captioned, text-generation
```

## How a host sees it

The runtime never says "cached". Two signals on its public surface do, and
[`src/observe.ts`](./src/observe.ts) reads both:

- **`job:step`** fires on the plan's own stream as each step settles, carrying
  the plan's own `stepId` and the sub-dispatch's `childJobId`. It fires for a
  dedup hit too, so the same id shows up again.
- **`InlineRuntimeInit.onJobCreated`** fires once per row the runtime
  *inserts*. A dedup hit inserts nothing.

The `cached` column above is derived from both, never from a flag the runtime
did not send — and it is asked of the child's own row id, because `describe` and
`caption` are both `text-generation` and a pattern-keyed answer would confuse
them.

## What the walk refuses, before anything runs

`validatePlan` is pure, synchronous and lists **every** problem at once — a
model (or a host) gets the complete list in one turn rather than discovering
mistake two after paying for step one. On this plan it checks, among 24 rules,
that `startFrame` is a declared slot of `image-to-video`, that `text-to-image`
produces `image` where that slot wants `image`, that `.text` really is a field
of what `text-generation` returns, that every reference points at a step listed
*earlier* (which is the cycle check), and that no step is paid for and
discarded. The smoke test pins it against the real registry:

```ts
expect(validatePlan(SHORT_CLIP_PLAN, lookup, {
  selfId: 'meta_short-clip', inputs: ShortClipInputSchema,
})).toEqual([])
```

A failing step fails the plan job with **its own** code, plus
`error.details.planStepId` naming the step — the steps that succeeded are rows
in the store and are not re-run on resubmit.

## Files

| file | what it is |
| --- | --- |
| [`src/short-clip.plan.json`](./src/short-clip.plan.json) | the pipeline, as data |
| [`src/pattern.ts`](./src/pattern.ts) | the factory: `planToMeta` + the `$input` schema |
| [`src/plan-captioned.ts`](./src/plan-captioned.ts) | the same plan with one step inserted |
| [`src/mock-models.ts`](./src/mock-models.ts) | three `ModelCapability` envelopes, no key |
| [`src/observe.ts`](./src/observe.ts) | how a host sees a dedup hit |
| [`src/main.ts`](./src/main.ts) | the wiring and the printing |
