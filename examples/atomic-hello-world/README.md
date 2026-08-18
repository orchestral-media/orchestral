# atomic-hello-world

A from-scratch host that runs one atomic `text-to-image` dispatch through the
published `@orchestral/*` packages and prints the generated image. The entire
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
  host territory, and the @orchestral packages ship no provider adapter. So we
  write our own here: [`src/ai-sdk-wiring.ts`](./src/ai-sdk-wiring.ts) is the
  ~50-line bridge that turns an ai-sdk model instance (built with your own
  key) into the `call` adapter the router dispatches through, via the `ai` SDK's
  `generateImage` (this example pins `ai@^7`). Copy it into your own host, or swap `generateImage` for
  whatever provider SDK you use.
