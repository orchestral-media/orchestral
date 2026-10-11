---
'@orchestral/core': minor
'@orchestral/runtime': minor
'@orchestral/plan': minor
'@orchestral/agent': minor
---

A Pattern that produces assets takes an optional `input.name`, and the produced asset's handle is that name.

**Why.** Handles were only ever minted, at record time and in completion order. A model that dispatched eleven images in parallel and then wrote `asset://image_4` from its own call order got a real image — the wrong one — and nothing failed. A name bound for the dispatch makes a reference the model did not copy miss with `HANDLE_NOT_FOUND` instead of landing on a neighbour.

**What the model sends.** Registration adds `name` to the tool inputs of every Pattern whose outputs carry `assets[]` — atomics, metas, plans and agents alike — so `dispatch_pattern`, always-load tools, `find_pattern` and the agent loop all carry it. It is trimmed, `asset://hero` reads as `hero`, and a blank name means none. A name in any asset kind's mint grammar (`image_3`, `video_1`) is refused, so a chosen name can neither collide with a minted handle nor be read as a replay that moves the ledger's counter. One product takes the name; several take `<name>-1` … `<name>-n` in output order (`deriveNamedHandles`). A `name` on a Pattern that produces no assets is refused with `INPUT_VALIDATION_FAILED` rather than dropped.

**What the host does.** `resolveAssetReferences` reads the name through the new `productNameOf` and refuses one the context already holds — exactly, or as a `<name>-<n>` — with a new `AssetResolutionError` variant, `HANDLE_TAKEN`, before anything else is evaluated; an exhaustive `switch` over the codes gains a case. `AgentAssetBridge.recordOutput` receives the normalised name, and the agent loop runs `resolveForDispatch` for a named dispatch even when the Pattern declares no asset slots. `mintNext`, `parseMintedHandle`, `producesAssets` and `RESERVED_INPUT_KEYS` are exported, so a durable `AssetStore` writes handles by the same rule as `InMemoryAssetStore` and a host can refuse a user-authored schema before saving it.

**Breaking (0.x, no shims).** `references` and `name` are reserved top-level input keys: registration derives both on a copy of the Pattern, and a hand-written top-level `references` or `name` throws `INPUT_RESERVED_KEY` (`details.key` names it) — delete it, registration derives it. `extendInputsWithReferences` no longer replaces a hand-written `references`; it throws the same error. A `references` produced by `extendInputsWithReferences`, or placed from `deriveReferencesSchema(...)` unwrapped, is recognised and re-derived from the Pattern's own `assetNeeds`. Nested keys are not reserved. `AGENT_BASE_INPUT_SCHEMA` no longer declares `references`: an agent that declares `assetNeeds` gets the derived field, and one that declares none has none — it was never resolved. `AgentBaseInput`, `agentInputSchema`'s result and `OrchestratorInputSchema` change type with it. An asset-producing Pattern whose tool inputs is not a `z.object` is refused at registration (`EXTEND_NAME_UNSUPPORTED_INPUTS`).

**Prompt caches miss once.** Every asset-producing Pattern's tool schema gains a field, and agent schemas lose their hand-written `references`, so provider-side prompt caches built on the old tool definitions invalidate once.

**Part of the work.** `name` is hashed with the rest of `input`, with no special case: a retry repeats the name and still dedupes, and the same prompt under two names is two products. Nothing is added to `JobSpec`. `meta_plan` reads its DAG without the reserved keys, so a named one-shot plan validates as before.

**Plans.** A `name` in a plan step's input is refused with the new `PlanProblemCode` `PLAN_STEP_NAME_NOT_ALLOWED`: a step's products are never recorded under a name, so the plan names its own product instead. A step's `input.references` is unchanged.

**Known limitation.** A hand-written meta's `compose` is not validated, so a `name` it forwards into a sub-step input is never recorded and has no effect.
