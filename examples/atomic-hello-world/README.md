# atomic-hello-world

A from-scratch host that runs one atomic `text-to-image` dispatch through the
`@orchestral/*` packages and prints the generated image. The entire
host is the ~15 lines of wiring in [`src/main.ts`](./src/main.ts) plus one
OpenAI API key — there is **zero host engine code**.

## Run it

```sh
export OPENAI_API_KEY=sk-...
pnpm install
pnpm --filter atomic-hello-world start
```

It dispatches `{ prompt: 'a red bicycle' }`, waits for the (synchronous) job to
finish, and logs each produced image asset's URI.

> **`submitJob` rejects on terminal failure.** The runtime marks the job row
> `errored` and rethrows, so in a real host the failure path is a `try` /
> `catch` around the `await` — that is the branch you will actually hit. The
> `job.status !== 'done'` guard in `main.ts` covers the one case that does *not*
> throw: an idempotency-dedup hit hands back an existing row, which may still be
> in flight.

## No key? Run the smoke test

```sh
pnpm --filter atomic-hello-world test
```

[`src/__tests__/wiring.smoke.test.ts`](./src/__tests__/wiring.smoke.test.ts)
runs the **same** registry → router → runtime → `submitJob` path with a mock
image model (`MockImageModelV3` from `ai/test`) in place of the real OpenAI
instance, so it links end to end with no network and no API key. It also runs
as part of the repo's `pnpm test:run`.

## What's host territory vs. what ships in the box

- **`JobStore` and `CapabilityRouter`** use the zero-dependency defaults that
  ship with the packages — `InMemoryJobStore` and `createDefaultCapabilityRouter`
  from `@orchestral/core`. Nothing to implement.
- **`ModelCapability.call`** — the part that actually talks to a provider — is
  host territory: `@orchestral/core` / `runtime` / `patterns` ship no provider
  adapter. For the AI SDK that adapter is packaged as the leaf
  [`@orchestral/adapters-ai-sdk`](../../packages/orchestral-adapters-ai-sdk)
  (`fromImageModel`), which is what [`src/ai-sdk-wiring.ts`](./src/ai-sdk-wiring.ts)
  now calls — the host's remaining job is to say which models it serves and
  hand the router a `getModels`. The hand-written version of the same bridge
  is the root README's "Minimal example"; on a different provider SDK, copy
  that and swap `generateImage` for your own client. This example pins `ai@^7`.
