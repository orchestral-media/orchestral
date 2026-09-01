# Design: what Orchestral refuses to do, and why

Orchestral is defined as much by what it leaves out as by what it ships. Every
refusal below is enforced in code — a type that cannot express the thing, a
schema that rejects it, a default that is off — and argued at the cited
location, usually in a source comment. Each citation names an anchor the cited
file carries (`DESIGN: <slug>`) rather than a line range, and
`tests/design-anchors.test.ts` fails if an anchor moves out from under its
citation or outlives it. This page collects those arguments so a
reader does not have to find them across six packages. If you want to propose
removing one, argue against the stated reason; the reason is the thing to beat.

## Vocabulary & contracts

### We don't ship a provider SDK in core, and we don't ship an agent loop
**Why.** `ModelCapability` is "record + host-injected adapter": the adapter "is
responsible for mapping the input + ctx to the underlying provider SDK", and the
default router "does NOT construct `call` and never touches a provider SDK".
One level up, "the tool-loop driver is deliberately absent … shipping a loop
here would mean shipping an agent-framework choice (and its provider SDK) inside
a pattern catalog." The cost is real: with core alone, the first fifteen minutes
are spent writing an adapter, and an agent-kind dispatch with no injected runner
throws `AGENT_RUN_IMPL_NOT_INJECTED`. Where an SDK binding does ship, it ships
as a leaf — `@orchestral/adapters-ai-sdk` "depends on `@orchestral/core` and
`ai`; nothing in `@orchestral/*` depends on it" — the same arrow-never-reverses
rule as the dsh bridge below.
**Instead.** A ~15-line `call` over whichever SDK you already use (README,
"Minimal example"), or the leaf adapters package when the AI SDK is the one you
use; for agents, inject `InlineRuntimeInit.agentRunImpl` —
`examples/agent-hello-world/src/agent-runner.ts` is a copy-paste reference over
the AI SDK's `ToolLoopAgent`.
**Where.** `packages/orchestral-core/src/capability-model.ts` (DESIGN: model-capability-call-seam),
`packages/orchestral-core/src/capability-router-default.ts` (DESIGN: get-models-no-prefilter),
`packages/orchestral-agent/src/index.ts` (DESIGN: agent-loop-driver-absent),
`packages/orchestral-runtime/src/agent-dispatch.ts` (DESIGN: agent-run-impl-not-injected),
`packages/orchestral-adapters-ai-sdk/src/index.ts` (DESIGN: adapters-ai-sdk-leaf).

### We don't run a plugin framework
**Why.** The pattern-package manifest is "a convention plus a loader
(`PatternRegistry.addFromManifest`), not a plugin framework: no lifecycle, no
sandbox, no version negotiation, no activation events. A pattern package is an
ordinary npm package whose factories a host could equally well call by hand;
the manifest only removes the hand-written wiring and the drift that comes with
it." The README states the consequence: "The manifest is a declaration, not a
permission boundary. Reading it is safe; loading the package runs its code,
exactly like any other import."
**Instead.** Discovery is a query — the npm keyword `orchestral-pattern`, the
GitHub topic, the `orchestral-pattern-*` name — and loading is
`registry.addFromManifest(pkg.orchestral, module, ops)`.
**Where.** `packages/orchestral-core/src/manifest.ts` (DESIGN: manifest-not-a-plugin-framework);
`packages/orchestral-core/README.md` (DESIGN: manifest-declaration-not-permission);
`packages/orchestral-core/src/__tests__/manifest.test.ts`.

### We don't version the manifest
**Why.** "Unknown keys are IGNORED rather than rejected: a package built against
a later manifest shape must still load on an older `@orchestral/core`. That
forward compatibility is why there is no version discriminator — the package's
own semver and its `@orchestral/core` peer range already carry that information,
and a second version number would only be a second thing to keep in sync."
**Instead.** Bump the package's own version and its `@orchestral/core` peer range.
**Where.** `packages/orchestral-core/src/manifest.ts` (DESIGN: manifest-no-version-discriminator).

### We don't accept a package-level `requiredOps`
**Why.** Host operations are declared per pattern because "a package-wide list
is all-or-nothing, so one ffmpeg-shaped meta would make the other two dozen
patterns unloadable for a host that has no ffmpeg — which is the opposite of
what a manifest is for." The key is refused, not ignored: "silently dropping a
declaration whose whole point is fail-closed op checking is the one outcome
worse than either behaviour." This is narrower than the unknown-keys rule
above: "an unrecognized key is a later manifest shape an older core should
tolerate, whereas this one is a key whose meaning changed."
**Instead.** `patterns[].requiredOps` on the entries that need ops;
`addFromManifest(…, { missingOps: 'skip' })` registers the loadable subset and
reports the rest.
**Where.** `packages/orchestral-core/src/manifest.ts` (DESIGN: required-ops-per-pattern) and
`packages/orchestral-core/src/manifest.ts` (DESIGN: package-required-ops-refused) (a
`z.undefined()` with a custom error);
`packages/orchestral-core/src/__tests__/manifest.test.ts` ("rejects a package-level requiredOps instead of ignoring it").

### We don't prefix atomic ids
**Why.** An atomic Pattern's id *is* its capability: "PatternId === Capability
literal. No scope prefix" (foundational.ts), "Pattern : Capability = 1:1 —
`Registry.get(capability as PatternId)` is the canonical capability lookup"
(registry.ts). The runtime dispatches on that equation — `inline.ts` asks the
router `checkSatisfiable(atomic.id as Capability, …)` — so a prefix on atomic
ids would need a mapping table between two vocabularies, and a table is a
second thing to keep in sync. The names are the HuggingFace task taxonomy for
ecosystem familiarity, with zero dependency on HuggingFace. Meta and agent ids
do carry `meta_` / `agent_`, because there the prefix is what `inferNamespace`
and `DEFAULT_SUBAGENT_BLOCKLIST.idPrefixes` route on: "This is a normative
contract, not a coincidence of naming. The recursion guard is implemented as
an id-PREFIX match, so an AgentPattern whose id does not start with `agent_`
silently escapes it". Underscore rather than colon, because "the
Anthropic/OpenAI tool name regex `[a-zA-Z0-9_-]` disallows colons — underscore
lets the internal id double as the LLM tool name with zero encoding." The
contract is enforced on both ways into the registry — `addFromManifest`
through the manifest schema's `.refine`, `register()` directly — as
`PATTERN_ID_KIND_MISMATCH`.
What a bare capability id does not give a third party is a namespace:
`Capability` is open (`string & {}`), so package A's and package B's
`video-concat` are the same registry key and the second to load fails with
`PATTERN_ALREADY_REGISTERED`. The answer is not a prefix on every atomic — the
equation above is worth more — but one on the capability name itself,
`<vendor>__<capability>` (`acme__video-concat`): two underscores, a separator
no first-party id uses, still a legal tool name. The registry warns
`CAPABILITY_NOT_NAMESPACED` for an atomic whose id is neither a capability
core names nor vendor-prefixed. Warns, not throws: a host that loads exactly
one such package has nothing to fix, and the line is addressed to the
package's author.
**Instead.** Atomic: the bare taxonomy name (`text-to-image`), or
`<vendor>__<name>` for a capability core does not define. Meta: `meta_<name>`.
Agent: `agent_<name>`.
**Where.** `packages/orchestral-core/src/foundational.ts` (DESIGN: pattern-id-is-capability),
`packages/orchestral-core/src/foundational.ts` (DESIGN: agent-id-prefix-normative);
`packages/orchestral-core/src/capability.ts` (DESIGN: capability-union-list-lock);
`packages/orchestral-core/src/manifest.ts` (DESIGN: id-carries-kind);
`packages/orchestral-core/src/registry.ts` (DESIGN: pattern-capability-one-to-one),
`packages/orchestral-core/src/registry.ts` (DESIGN: register-id-kind-check),
`packages/orchestral-core/src/registry.ts` (DESIGN: capability-not-namespaced-warn);
`packages/orchestral-core/src/catalog.ts` (DESIGN: subagent-blocklist-prefix),
`packages/orchestral-core/src/catalog.ts` (DESIGN: infer-namespace-by-prefix);
`packages/orchestral-runtime/src/inline.ts` (DESIGN: atomic-id-as-capability-lookup);
`packages/orchestral-core/src/__tests__/register-id-kind.test.ts` ("refuses an agent Pattern whose id lacks the agent_ prefix");
`packages/orchestral-core/src/__tests__/register-capability-namespace.test.ts` ("warns for a bare third-party capability id, and still registers it").

### We don't accept raw JSON Schema as an authoring format
**Why.** Patterns are zod throughout; JSON Schema exists only as the outbound
wire format, because "the LLM only understands JSON Schema, and zod can't cross
a process boundary". The file lists the trade-offs: "No raw JsonSchema authoring
(YAGNI — no users actually want it; adding ensureZod + a json-schema-to-zod dep
later is a ~30 min change)" and "No Schema interface abstraction
(over-engineering — zod-native ops are faster directly)". The lossiness is
one-way and named: `.refine` / `.transform` do not survive `toJsonSchema`,
"which matches the reality of LLM tool specs".
**Instead.** Author in zod; call `toJsonSchema(zodSchema)` at the one boundary
(catalog, IPC, persistence). It is literally one: `z.toJSONSchema` is called in
`schema.ts` and nowhere else under `packages/*/src`, so the draft-2020-12
target that the byte-stability invariant rides on is decided once. A source
scan holds the line — nothing in the type system would notice a second
serialiser that quietly picked a different target. zod v4 is a peer dependency
for the same reason: one instance, shared with the host.
**Where.** `packages/orchestral-core/src/schema.ts` (DESIGN: zod-only-authoring);
`packages/orchestral-core/src/index.ts` (DESIGN: to-json-schema-boundary-export).

### We don't give an atomic adapter `ctx.step`
**Why.** "An atomic Pattern is restricted to the single `ModelCapability.call`
its primary path resolves to and never sees `ctx.step` — multi-step fallback
goes through declarative `alternatives` → meta." The restriction is in the
types, not a runtime check: the adapter receives `DispatchContext`, "which
carries no `step` (atomic is single-LLM by definition)"; only
`MetaPattern.compose()` receives `ExecutionContext`.
**Instead.** Anything that needs two calls is a meta. An atomic that wants a
different path on failure declares an `Alternative` that points at one.
**Where.** `packages/orchestral-core/src/execution-context.ts` (DESIGN: atomic-never-sees-ctx-step),
`packages/orchestral-core/src/execution-context.ts` (DESIGN: execution-context-meta-only).

### We don't let a stop condition be a predicate
**Why.** `StopConditionDescriptor` is "a single-valued enum, not a predicate
closure (prevents a Pattern spec from carrying non-serializable runtime logic)".
A Pattern spec has to survive JSON — the catalog, the manifest and the
transcript all assume it.
**Instead.** `{ kind: 'step-count', n }` or `{ kind: 'token-count', n }`; the
host's `AgentRunImpl` maps these onto its own SDK's stop conditions.
**Where.** `packages/orchestral-core/src/pattern.ts` (DESIGN: stop-condition-not-a-predicate).

### We don't put cost or latency on the routing types
**Why.** "There is deliberately no cost or latency metadata on these types:
media generation cost is not reliably computable up front, so anything
cost-aware belongs in your own `getModels` ordering or a custom router. If such
a field ever lands, it lands together with the behaviour that enforces it." The
same rule keeps three neighbouring flags off `ModelCapabilityBlob` — a
joint-audio flag, per-modality input flags, an SDK factory name — "because each
would double-source data this record already carries."
**Instead.** Order `getModels` by your own cost model, or implement
`CapabilityRouter` directly.
**Where.** `packages/orchestral-core/CHANGELOG.md` (DESIGN: changelog-no-cost-on-routing-types);
`packages/orchestral-core/src/capability-model.ts` (DESIGN: no-cost-or-latency-fields).

## Routing & fallback

### We don't let the host pre-filter candidates, and we don't pre-screen adapters
**Why.** `getModels` must return every model that declares the capability: "do
NOT pre-filter on exclude / tag / tier / ranked here. That filtering belongs to
this router; pre-filtering would defeat `diagnoseReason`'s step-by-step
elimination (it needs the full declared set to tell `tag-mismatch` from
`all-excluded`)." Nor does the router screen for adapter compatibility:
"Deciding at expose time whether a provider is 'runnable' is a model-centric
guess that wrongly drops records — most visibly for providers that proxy many
upstream models under one name. Dispatch fails loudly instead."
**Instead.** Express preference through `getCapabilityOrder` and
`ResolveContext.rankedModels` / `pinnedModel` / `excludeModel`; let a bad
adapter throw at `call`, where the error is the actionable one.
**Where.** `packages/orchestral-core/src/capability-router-default.ts` (DESIGN: get-models-no-prefilter),
`packages/orchestral-core/src/capability-router-default.ts` (DESIGN: no-adapter-prescreen);
`packages/orchestral-core/src/__tests__/capability-router-default.test.ts` ("required tag not borne by any model → 'tag-mismatch'").

### We don't take a semantic fallback unless the host asks
**Why.** "Declaring an alternative does not make it fire." `InlineRuntime`
defaults to `alternatives: 'off'` "because substituting a semantically
different path is a product decision, not a runtime one: a caller who asked for
an identity-preserving edit and silently received a re-render from a caption
got a different answer, not a retry. Failing loudly with the paths named keeps
that choice with the host." The runtime README adds that the comparable
libraries surveyed "all fail explicitly here and leave the substitution to the
caller".
**Instead.** Read `ALTERNATIVES_NOT_ENABLED`'s `details.diagnostic` — every
applicable path, by id and target — and submit one yourself; or construct the
runtime with `alternatives: 'auto'` and listen for `job:alternative-selected`,
which carries the `losses`.
**Where.** `packages/orchestral-core/src/alternative.ts` (DESIGN: declaring-does-not-fire);
`packages/orchestral-runtime/src/inline.ts` (DESIGN: alternatives-default-off),
`packages/orchestral-runtime/src/inline.ts` (DESIGN: alternatives-off-is-a-product-decision);
`packages/orchestral-runtime/README.md` (DESIGN: readme-alternatives-off-by-default);
`packages/orchestral-runtime/src/__tests__/alternatives-default-off.test.ts` ("alternatives default to off").

### We don't ship a fallback that cannot reconstruct the caller's intent
**Why.** `via-caption` on `image-to-image` is the only first-party
`Alternative`, "and that is a position rather than a coverage gap: a fallback is
honest only when some other capability can reconstruct the caller's intent, and
`image-to-text` + `text-to-image` is the one pair in the first-party catalog
that carries content across a modality gap." Each pattern without one says why
beside its `alternatives` field: for ASR, "a guessed transcript is fabrication,
not degradation"; for TTS, routing `text` to `text-to-audio` "yields audio
*about* those words instead of those words spoken"; for text-to-video the honest
chain (still → animate) "is a chain an Alternative cannot express by itself",
and pointing at an unregistered id "would be strictly worse than the current
behaviour".
**Instead.** Every atomic factory takes an `alternatives` option that replaces
the shipped list outright. With none, the job fails with the router's
`NO_MODEL_FOR_CAPABILITY` "instead of quietly producing something adjacent".
**Where.** `packages/orchestral-core/README.md` (DESIGN: readme-via-caption-only-alternative);
`packages/orchestral-patterns/src/meta/image-to-image-via-caption/index.ts` (DESIGN: via-caption-first-party-fallback),
`packages/orchestral-patterns/src/atomic/automatic-speech-recognition.ts` (DESIGN: asr-no-fallback),
`packages/orchestral-patterns/src/atomic/text-to-speech.ts` (DESIGN: tts-no-fallback),
`packages/orchestral-patterns/src/atomic/text-to-video.ts` (DESIGN: text-to-video-no-fallback),
`packages/orchestral-patterns/src/atomic/image-to-text.ts` (DESIGN: image-to-text-no-fallback).

### We don't guess which failures are transient
**Why.** "The library never guesses transience, because guessing wrong spends
real money in both directions: a 429 read as fatal drops the dispatch onto a
pricier or worse candidate, and a content rejection read as a blip pays for the
same refusal three times. Only host code holding the provider SDK's own error
shapes can tell those apart, so there is no built-in classifier to fall back on
— without this field nothing is transient." A predicate that throws is "read as
'not transient', which is the fail-closed answer", so a host bug never displaces
the provider error it was asked about.
**Instead.** `InlineRuntimeInit.transientRetry: { isTransient, policy }`.
`isTransient` receives the capability, model and attempt number, so one
predicate can treat a cheap image call and an expensive video call differently.
**Where.** `packages/orchestral-runtime/src/inline.ts` (DESIGN: no-built-in-transience-classifier),
`packages/orchestral-runtime/src/inline.ts` (DESIGN: is-transient-throw-is-false);
`packages/orchestral-runtime/src/__tests__/transient-retry.test.ts` ("is off by default — a failing model is called once and excluded").

### We don't let the retry budget and the fallback budget spend each other
**Why.** "Two budgets, two loops, and neither can spend the other's." The outer
loop walks candidates through `excludeModel`; the inner loop re-calls one model
under `transientRetry`. "A model is excluded only once this loop is done with
it, so a retried blip never costs a fallback hop and a long fallback chain never
buys extra attempts at one provider." The vocabulary is precise about it:
"'Given up on' is not the same as 'failed once'" — a model lands in
`excludeModel` only when its own retries are spent. A third bound,
`maxAlternativeDepth`, caps cross-Pattern redirects and is deliberately neither
of these.
**Instead.** `ResolveContext.fallbackDepth` (per dispatch;
`rankedModels.length - 1` walks exactly the configured chain),
`transientRetry.policy.maxAttempts`, and `maxAlternativeDepth` — three knobs
for three loops.
**Where.** `packages/orchestral-runtime/src/inline.ts` (DESIGN: two-budgets-two-loops);
`packages/orchestral-core/src/capability-model.ts` (DESIGN: exclude-model-after-retries-spent),
`packages/orchestral-core/src/capability-model.ts` (DESIGN: fallback-depth-per-dispatch);
`packages/orchestral-runtime/src/__tests__/transient-retry.test.ts` ("keeps the retry budget and the fallback budget out of each other").

### We don't fall back to BM25 to name a direct tool
**Why.** The one decision in the repo backed by a measured number. When a
`find_pattern` query misses, the "you already have this as a direct tool" hint
is deterministic — exact id, short name, spaced-id substring — and "Deliberately
NO BM25 fallback: measured on real traffic it named the wrong tool on 6/7
unrelated prose queries via stopword matches — an imperative hint naming the
wrong tool (worst case: a paid generation call) costs far more than the one
extra find_pattern round-trip a miss costs, and flailing models converge to
id-shaped queries on their own."
**Instead.** Nothing: the model gets a zero-match diagnostic and asks again.
**Where.** `packages/orchestral-discovery/src/find-pattern.ts` (DESIGN: no-bm25-direct-tool-hint);
`packages/orchestral-discovery/src/__tests__/find-pattern.test.ts` ("prose query without the id substring does NOT hint (no BM25 oracle)").

## Execution & recovery

### We don't resume lost jobs
**Why.** After a crash, `abandonOrphanedJobs()` marks the queued / running rows
a dead process left behind as terminal `stale`; "the work itself is gone and is
never re-attached or re-run." The contract makes that a rule for every
substrate: "This is abandonment with bookkeeping, on every substrate: a
substrate that can genuinely resume lost work should expose that as its own
call rather than hiding resumption behind this one, so a caller can always read
the returned rows as dead." "Terminal" there is enforced rather than asserted:
`nextJobState` refuses every move out of `stale` — out of any of the four
settlements — so a store cannot quietly write an abandoned row back to
`running` and re-present dead work as live. The cost: there is no durable
queue, and a parked `ctx.askUser` does not survive a restart either.
**Instead.** Call `abandonOrphanedJobs()` at process start, subscribe to
`job:stale`, and resubmit what matters — idempotency makes a resubmit cheap
when the prior row succeeded.
**Where.** `packages/orchestral-core/src/runtime.ts` (DESIGN: abandonment-with-bookkeeping);
`packages/orchestral-core/src/job-state.ts` (DESIGN: terminal-status-never-moves);
`packages/orchestral-runtime/CHANGELOG.md` (DESIGN: changelog-no-durable-queue);
`packages/orchestral-runtime/src/__tests__/abandon-orphaned-jobs.test.ts` ("transitions orphaned running/queued rows to stale and returns them").

### We don't hash the whole JobSpec for idempotency
**Why.** "The field list below is a hand-picked allowlist, not a spread of the
JobSpec. Two dispatches dedupe iff they agree on **what work to do**":
`patternId`, `input`, resolved `assets`, `sessionId`, `stepIndex`. "Everything
else on JobSpec is **routing metadata** and is excluded on purpose" —
`providerOptions` ("folding them in would split the dedup space every time a
host setting changes"), `assetContextId`, `resolveHints` ("a retry with a
different model-exclusion set is the same work, routed elsewhere"),
`stepIdNamespace`, `resumeFromRunId`, `jobKind`. Non-JSON values (Map / Date /
Buffer / BigInt) are rejected loudly rather than silently colliding, and failed
rows never dedupe: "error / stale / cancelled deliberately do NOT match so the
caller can retry after an explicit failure."
**Instead.** Pass `idempotencyKey` yourself when your notion of identity
differs. "Adding a field here changes dedup behaviour for every existing job
row."
**Where.** `packages/orchestral-runtime/src/idempotency.ts` (DESIGN: idempotency-identity-allowlist);
`packages/orchestral-core/src/job.ts` (DESIGN: jobspec-identity-vs-routing);
`packages/orchestral-core/src/job-store-memory.ts` (DESIGN: failed-rows-never-dedupe);
`packages/orchestral-runtime/src/__tests__/idempotency.test.ts`,
`packages/orchestral-core/src/__tests__/job-store-memory.test.ts` ("still inserts when the only same-key row is non-canonical (retry after failure)").

### We don't content-hash step ids
**Why.** A default step id is `${patternId}#${counter}` — "a deliberately
simple form: production Patterns are write-once, so the author owns the fact
that reordering code invalidates resume." That sentence is the cost. The
alternative is worse: the step cache is keyed by step id, and a key derived from
`(patternId, input)` would make `meta_image-best-of-n` — which fans out N
identical dispatches by design — collapse "N 'samples' into a single cached
result". The counter is shared across nested metas so default ids are
tree-unique; explicit ids are namespaced by the parent step, and a collision
throws `DUPLICATE_STEP_ID` rather than silently sharing a cache entry.
**Instead.** Pass `stepId` explicitly for fan-out (`candidate-${i}`) — "the
documented bypass", and the stable key resume needs. Since plans there is a
second documented bypass: `StepOptions.identity: 'id'` keys the dispatch by its
namespaced step NAME (`JobSpec.stepKey`) instead of by position, so inserting a
step into an edited plan re-runs one dispatch, not everything after it. It is
opt-in per step, requires an explicit `stepId`, and positional stays the
default — the conditional spread in `deriveIdempotencyKey` keeps every
pre-`stepKey` payload byte-identical.
A third bypass goes further and hands the question over entirely:
`StepOptions.idempotencyKey` keys the row on a string the CALLER derives,
skipping `deriveIdempotencyKey` the way `JobSpec.idempotencyKey` always has for
a host submitting directly. This is not the refusal above being reversed — the
library still derives no content hash of its own, and still will not decide that
two identical dispatches are one unit of work. It is the seam for a caller whose
notion of "the same work" the derivation cannot express, the concrete case being
reuse that outlives a session: `sessionId` is hashed on purpose ("dedup never
crosses a session boundary"), so no choice of `identity` mode escapes it. The
burden moves with the key and is stated where it is declared — within one
pattern, a key that omits something the step reads returns the earlier output
for later work, which is a stale but schema-valid result rather than an error.
One collision does not move with it: a key already held by a row for a
DIFFERENT pattern is refused, `IDEMPOTENCY_KEY_CROSS_PATTERN`. That row's output
was gated against the other pattern's `outputs` schema and never against this
one's, so returning it is not a stale answer to the caller's question but an
answer to a different one — and only a caller-supplied key can produce it, since
the derivation always hashes `patternId`. `runPlan` exposes the same seam as
`idempotencyKeyFor`, because the interpreter owns the `ctx.step` call and a
plan's steps would otherwise be the only steps that cannot reach the option; a
plan is also where the two ways to write the key badly show up, since one key
function serves many steps (a key ignoring the pattern hits the refusal above,
one ignoring the step id collapses a fan-out onto a row that has not finished —
`PLAN_STEP_IN_FLIGHT`).
**Where.** `packages/orchestral-runtime/src/meta-execution-context.ts` (DESIGN: default-step-id-is-positional),
`packages/orchestral-runtime/src/meta-execution-context.ts` (DESIGN: step-identity-requires-step-id),
`packages/orchestral-runtime/src/meta-execution-context.ts` (DESIGN: caller-supplied-step-identity),
`packages/orchestral-runtime/src/inline.ts` (DESIGN: idempotency-key-cross-pattern);
`packages/orchestral-patterns/src/meta/image-best-of-n/index.ts` (DESIGN: best-of-n-fan-out-note),
`packages/orchestral-patterns/src/meta/image-best-of-n/index.ts` (DESIGN: best-of-n-explicit-step-id);
`packages/orchestral-runtime/src/__tests__/meta-nested-stepid-namespace.test.ts` ("does not crash DUPLICATE_STEP_ID when the same child meta runs twice with fixed explicit stepIds"),
`packages/orchestral-runtime/src/__tests__/meta-step-idempotency-key.test.ts` ("dedupes across sessions, which the derived key cannot"),
`packages/orchestral-runtime/src/__tests__/meta-step-idempotency-key.test.ts` ("refuses a key that collides across two patterns");
`packages/orchestral-runtime/src/__tests__/meta-step-identity-id.test.ts`.

### We don't impose concurrency caps, timeouts, or TTLs
**Why.** "There is no concurrency limit, no per-step timeout and no job TTL.
Cancellation is by `AbortSignal`; concurrency limits and wall-clock deadlines
are the host's to impose." `InlineRuntime` runs a job in the caller's tick: it
has no queue to throttle and no clock of its own, and any number it picked
would be a number nobody chose for your surface.
**Instead.** Wrap `submitJob` in your own semaphore; drive `ctx.signal` from
your own deadline (a parent signal propagates into every child dispatch); count
calls per `rootJobId` in `beforeDispatch` for a spend cap — `rootJobId` exists
for exactly that and is deliberately not persisted on `Job`, "that would put a
column on every host `JobStore` to serve bookkeeping the host can do in its own
tables."
That semaphore has one blind spot, and it is where this refusal has to hand the
host a seam rather than only a sentence: a plan's levels fan out INSIDE a single
`submitJob`. From outside, the plan is one job — the host has one call
outstanding while the interpreter has twenty in flight — so a decision this
entry assigns to the host is one the host had no way to exercise.
`parallel.limit` is the mechanism and `RunPlanOptions.concurrency` (also on
`PlanToMetaOptions` and `createPlanMeta`) is where a host names a number.
Default unlimited, and the library still picks none: this is the difference
between refusing to impose a policy and refusing to provide the mechanism, and
only the first was ever the argument. The cost of turning it on — a capped step
starts when an earlier one settles, so the tree-shared counter stops handing a
nested meta's positional rows the same indices run after run — is stated where
the option is declared.
**Where.** `packages/orchestral-core/CHANGELOG.md` (DESIGN: changelog-no-timeout-no-ttl);
`packages/orchestral-runtime/CHANGELOG.md` (DESIGN: changelog-no-throttling-no-deadlines);
`packages/orchestral-core/src/execution-context.ts` (DESIGN: root-job-id-not-persisted);
`packages/orchestral-core/src/parallel.ts` (DESIGN: fan-out-cap-is-a-mechanism-not-a-policy);
`packages/orchestral-plan/src/interpreter.ts` (DESIGN: plan-concurrency-is-the-hosts-knob);
`packages/orchestral-runtime/src/__tests__/abort-cascade.test.ts`;
`packages/orchestral-patterns/src/__tests__/meta-plan-seams.test.ts` ("holds a capped level to the cap, and still finishes every step").

### We don't make `asset://` a fetch protocol
**Why.** The URI is only "the URI writing form of an AssetLedger reference":
`asset://<handle>` in prose or tool arguments is equivalent to a bare handle,
and "the URI carries only the handle segment — never an assetId / projectId /
sessionId (the ledger indirection invariant); whatever protocol a host uses to
fetch the actual bytes is a separate concern, don't conflate the two." Handles
are per-context, so a URI is not a global name and must not be persisted as one.
**Instead.** The host resolves handles against its own ledger and fetches bytes
however it already does. `setAssetUriScheme` renames the scheme once per process
if `asset://` collides with something in your host.
**Where.** `packages/orchestral-core/src/asset-uri.ts` (DESIGN: asset-uri-is-a-writing-form);
`packages/orchestral-core/src/__tests__/asset-uri.test.ts`.

### We don't stream progress as an `AsyncIterable`
**Why.** `CallEvents` is "discrete callbacks rather than `AsyncIterable<Event>`"
because provider SDKs "already expose their own progress callbacks (fal-queue,
runway task subscription) — a callback shape adapts to them in one line.
Wrapping each adapter as an async generator is gratuitous infra"; adapters with
no progress "pay literally zero cost — just don't reference the events object";
the runtime is the only consumer; and backpressure is not a concern for a
handful of coarse events per call.
**Instead.** Call `events?.onProgress({ fraction })` / `onArtifact(…)` from
inside your adapter when the SDK tells you something; the runtime fans them out
as job events.
**Where.** `packages/orchestral-core/src/capability-model.ts` (DESIGN: call-events-not-async-iterable).

## The LLM-facing surface

### We don't default an LLM surface to visible
**Why.** In the per-surface `exposure` object, "missing fields **fail-closed**:
LLM/user-facing surfaces (`chatTurn` / `agentLoop` / `slash` / `canvas`) default
to `false`; `host` defaults to `true` (host-direct is always reachable, never
blocked by any gate)." Exposure is a negative filter over audiences; a surface
the author did not name is one they did not consider.
**Instead.** Use the `'tool'` / `'agent-tool'` / `'no-tool'` shorthand (the
default `'tool'` is chat-turn + agent-loop), or name each surface. Every
consumer — catalog builder, `find_pattern`, the dsh bridge — reads it through
`resolveExposure`, never the raw field.
**Where.** `packages/orchestral-core/src/pattern.ts` (DESIGN: exposure-fail-closed),
`packages/orchestral-core/src/pattern.ts` (DESIGN: resolve-exposure-single-reader);
`packages/orchestral-core/src/__tests__/resolve-exposure.test.ts` ("fail-closed on missing LLM/user-facing surfaces; host defaults open"),
`packages/orchestral-core/src/catalog-builder.ts` (DESIGN: always-load-honours-exposure).

### We don't open a Pattern to anything its author didn't name
**Why.** Two closed-by-default rules. An agent's `toolPatternIds` "must be
listed explicitly (no '*' wildcard)"; `dispatchAgent` filters out the self id
and refuses a call to anything outside the list or already on the ancestor
chain. And `extensible` defaults to false: "Same philosophy as subagents
defaulting to disallowing the Task tool: capabilities are off by default, opened
explicitly by the author. Holding this invariant means a newly added third-party
package can't accidentally inject behavior into a first-party Pattern." A guard
trip inside the loop is a structured tool-result, not a failed job, so the model
can recover.
**Instead.** List the ids. The list only narrows: an `agent_`-prefixed id named
in `toolPatternIds` is still refused by `DEFAULT_SUBAGENT_BLOCKLIST`, at the
catalog and at the dispatch guard alike, so recursion is opened by supplying a
different blocklist and never by naming an id past this one. Declare
`extensible: true` on a Pattern you mean others to attach alternatives to;
`registry.attachAlternative` throws `PATTERN_NOT_EXTENSIBLE` otherwise.
**Where.** `packages/orchestral-core/src/pattern.ts` (DESIGN: extensible-closed-by-default),
`packages/orchestral-core/src/pattern.ts` (DESIGN: tool-pattern-ids-explicit);
`packages/orchestral-core/src/registry.ts` (DESIGN: pattern-not-extensible);
`packages/orchestral-runtime/src/agent-dispatch.ts` (DESIGN: subagent-tool-allowlist);
`packages/orchestral-runtime/src/__tests__/agent-tool-guards.test.ts` ("rejects a registered, agent-loop-visible pattern outside loop.toolPatternIds")
(no test pins `PATTERN_NOT_EXTENSIBLE` directly).

### We don't put resolved assets in the system prompt
**Why.** `SystemPromptContext` is "`DispatchContext` minus `assets`: the system
prompt is a **cached, byte-stable prefix**, so it must never embed volatile
resolved assets (those flow through the cache-cold seed announcement instead)."
The omission is in the type, so `loop.system` cannot reach `ctx.assets` by
accident. The cost: tier- or asset-specific prompt behaviour goes through
`modelTags` or a different `patternId`, not the prompt text.
**Instead.** Read `providerOptions` / `sessionId` / `project` to shape the
prompt; assets arrive in the seed message as `<available-assets>`.
**Where.** `packages/orchestral-core/src/execution-context.ts` (DESIGN: system-prompt-no-assets);
`packages/orchestral-core/src/pattern.ts` (DESIGN: system-prompt-context-on-loop-system).

### We don't let an output schema carry an unbounded string
**Why.** "When every string field in an outputs schema carries an explicit upper
bound, an unbounded blob is unrepresentable — a Pattern cannot accidentally push
megabytes of base64 into the model's context." The sanitizer is the backstop
("Length alone is NOT a strip signal"); the bounded vocabulary "makes the guess
unnecessary at the source". Registration warns rather than throws — "a throw
here would break existing under-specified patterns at registration; the warning
names the offending field paths instead" — the one deliberate exception to the
library writing nothing to stderr. Be precise about which seam does what: the
registry audits the *schema* at registration (is every string field bounded?),
and `InlineRuntime` holds every atomic and meta *output* to that schema at the
dispatch exit (does this output conform?) — one the schema rejects fails the job
with `OUTPUT_SCHEMA_MISMATCH`, carrying the zod issues and the raw output, so a
70 KiB completion stops at the adapter that produced it instead of reaching the
next step or `job.output`. A middleware `short-circuit` passes the same gate —
the value it supplies stands in for an adapter's return, so a cache entry the
schema no longer accepts fails the job rather than being served as this
Pattern's output. The gate sits outside the retry and fallback loops
(a mismatch is a contract violation, not a provider failure) and returns the
adapter's object rather than zod's reshaped copy. The agent path validates
through its finish tool. `InlineRuntimeInit.outputValidation: 'off'` is the
opt-out, for a migration window over adapters a host does not control. The
model-facing defence at run time remains the projection plus the sanitizer.
**Instead.** `boundedText(n)`, `opaqueToken()`, `assetIdField()`, `urlField()`;
`auditOutputsSchema` lists what slipped through.
**Where.** `packages/orchestral-core/src/output-fields.ts` (DESIGN: bounded-output-vocabulary);
`packages/orchestral-core/src/registry.ts` (DESIGN: outputs-unbounded-warn-not-throw);
`packages/orchestral-runtime/src/inline.ts` (DESIGN: output-schema-mismatch-gate);
`packages/orchestral-core/src/sanitize.ts` (DESIGN: length-alone-is-not-a-strip-signal);
`packages/orchestral-core/src/__tests__/output-fields.test.ts` ("auditOutputsSchema lists unbounded string paths").

### We don't let a real `assetId` or a signed URL reach the model
**Why.** An agent tool-result "goes straight into the loop's model context, so
it is projected HERE, on both paths … rather than left for a host to remember."
`projectToolOutputForModel` drops `assetId` / `url` and rebuilds `assets[]` from
the handle whitelist — "the verifiable assertion point for the no-assetId
invariant" — then `sanitizeToolOutput` scrubs `data:` URLs and binary runs. The
failure branch answers to the same rule by translation rather than projection:
a failed child's partial work reaches the loop as `produced_handles` this
context can name, or as a bare `produced_count`, never as the raw ids the
host-facing `JobError.producedAssets` keeps. The symmetric refusal matters as
much: "`InlineRuntime.dispatch()` deliberately
does NOT do this: it returns to the host, which needs the real assetIds and
URLs."
**Instead.** The model sees an opaque handle plus an `asset://` URI; the host
resolves them. Any bridge that puts a Pattern output into a model context
composes the same two calls in the same order (the dsh plugin does).
**Where.** `packages/orchestral-runtime/src/agent-dispatch.ts` (DESIGN: project-then-sanitize);
`packages/orchestral-core/src/asset-index.ts` (DESIGN: project-tool-output-hard-projection);
`packages/orchestral-runtime/src/__tests__/agent-tool-output-projection.test.ts` ("no bridge: the raw child output is projected — no assetId key and no signed URL reach the loop").

## Packaging & release

### We don't let core know about dsh — or any particular host
**Why.** "**Nothing in orchestral depends on this package, and nothing ever
will.**" The bridge "depends on them, and on dsh, and the arrow never
reverses"; it ships on its own version line because "dsh is a developer preview
whose README promises compatibility-breaking changes", so a dsh release can only
ever break the bridge. "Treat any pressure to 'just add a small dsh-shaped hook
in core' as the bug it is." The same shape holds inside the bridge: it "does not
build a Runtime" — store, router and credentials are "deployment decisions a
plugin has no business guessing".
**Instead.** A host-specific bridge is a leaf package that consumes a `Runtime`
and a `PatternRegistry` the host built, pinned exactly against the host's
version.
**Where.** `packages/orchestral-dsh-plugin/README.md` (DESIGN: dsh-bridge-is-a-leaf),
`packages/orchestral-dsh-plugin/README.md` (DESIGN: dsh-plugin-builds-no-runtime);
`PUBLISH.md` (DESIGN: publish-dsh-separately).

### We don't keep retrieval or the agent patterns in core
**Why.** `@orchestral/discovery` is "kept out of @orchestral/core deliberately.
Core is the contract … Which retrieval algorithm turns a free-form query into a
shortlist is a product decision a host may want to replace (embeddings, a hosted
search service, a hand-written router), and it drags in a search dependency
core should not carry." Only the wire schema (`FindPatternInputSchema`) stays in
core. `@orchestral/agent` is the same move: "Agent support is NOT part of the
core surface … Nothing in @orchestral/core, @orchestral/runtime or
@orchestral/patterns depends on it."
**Instead.** Install `@orchestral/discovery` / `@orchestral/agent` when you want
the first-party ones; replace either by implementing against the core
contracts. `@orchestral/runtime` holds the same line rather than quietly
breaking it: retrieval reaches an agent loop only through the injected
`InlineRuntimeInit.patternSearch` seam (`PatternSearch`, a core contract with
no implementation behind it), a loop with no seam wired is handed no
`find_pattern` tool at all, and installing the runtime therefore installs no
search engine. `@orchestral/plan` is the same move carried one step further: a plan
is one Pattern's wire format, not the library's vocabulary, so its schema left
core along with the walk, the interpreter and the preflight — the primitive all
four share ("read a `$ref` off a step's input") had been copied once per package
and is now a function they call.
**Where.** `packages/orchestral-discovery/src/index.ts` (DESIGN: discovery-out-of-core);
`packages/orchestral-core/src/index.ts` (DESIGN: find-pattern-schema-stays-in-core);
`packages/orchestral-agent/src/index.ts` (DESIGN: agent-package-optional).

### We don't evaluate anything in a plan
**Why.** A plan `$ref` is a path, not an expression: no interpolation, no
arithmetic, no conditionals, no `map`. The cost is real and named: none of the
three richest shipped metas can be written as a plan, because each parses JSON
out of a `text-generation` `.text` and fans out to a width the model chose
(`product-photo-pack`, `storyboard`, `image-best-of-n`). The moment the grammar
can express `if` it is a second Pattern language with none of the type checking
the first one has, and it needs the sandbox "We don't run a plugin framework"
refuses.
**Instead.** A transform is a `text-generation` step; a decision is a shipped
meta called as one step (`$hero.assets[label=winner]`); a dynamic width is
authored as a fixed one.
**Where.** `packages/orchestral-plan/src/plan.ts` (DESIGN: plan-ref-grammar);
`packages/orchestral-plan/src/validate.ts` (DESIGN: plan-no-interpolation);
`docs/plan.md` (DESIGN: plan-doc-no-evaluation).

### We don't give a plan its own Alternatives
**Why.** `Alternative.via.mapInput` / `mapOutput` are closures by design
(`alternative.ts`, the authoring contract on `Alternative`) and cannot survive JSON. Alternatives are also
evaluated only for atomic dispatches, so a meta — plan or hand-written — never
has semantic fallback of its own.
**Instead.** A plan inherits whatever is attached to the atomics it dispatches;
`preflightPlan` reports which would fire, and the runtime's `alternatives` mode
still decides whether one does.
**Where.** `packages/orchestral-plan/src/preflight.ts` (DESIGN: preflight-alternative-would-fire);
`packages/orchestral-core/src/alternative.ts` (DESIGN: alternative-map-closures).

### We don't add a partial-success state for plans
**Why.** A plan is a meta, so the job is one row whatever the interpreter does
inside it. The steps that succeeded are already rows of their own in the
JobStore and hit on the next submit; a status for "some steps done" would be a
second source of truth for what the store already records, and a column on every
host store to serve it. Note the argument does not rest on how the levels are
scheduled — it used to be stated as "`parallel()` is `Promise.all`", which the
interpreter no longer does. The keep-going walk (`parallel.limit`, failures
collected, dependents invalidated) makes MORE of a failed plan land in the store
rather than less, so it strengthens this refusal: the more a resubmit finds
already banked, the less a partial-success status would be telling anyone that
the store cannot.
**Instead.** `job.error.details.planStepId` names the failed step; `job:step`
events name the ones that landed; resubmit — the finished steps come back from
the store.
**Where.** `packages/orchestral-plan/src/interpreter.ts` (DESIGN: plan-step-failure-stamped);
"We don't resume lost jobs" above.

### We don't rewrite a step's input at execution
**Why.** The plan interpreter's layer-2 parse is a gate that dispatches the
original value. A defaults-applied copy would change the child's idempotency
input relative to a hand-written meta's and, for `text-generation`, key every
plan step differently from every meta step with the same prompt.
**Instead.** `safeParse` for the verdict, dispatch the input as written.
**Where.** `packages/orchestral-plan/src/interpreter.ts` (DESIGN: plan-layer-2-gate-not-rewrite);
pinned with `toBe` in `packages/orchestral-patterns/src/__tests__/meta-plan.test.ts`.

### We don't require a meta to declare what it dispatches
**Why.** `plannedDispatches` cannot be made mandatory without lying about
what it is. A meta that fans out to a width the model chose, or branches on a
sub-step's output, has no id list before `compose` runs; a declare-or-refuse
rule would either lock those metas out of every agent loop or push them into
naming half the catalog — a permission grant wearing a check's clothes. It is
also a pre-check, not an enforcement: nothing at `ctx.step` holds a meta to
what it declared, so requiring the field would advertise a guarantee the
engine does not make. And an undeclared meta running its inner steps outside
the caller's `toolPatternIds` is behaviour the guards suite calls legitimate
and depends on (`agent-tool-guards.test.ts`, "leaves an UNDECLARED meta free to
step outside the allowlist") — every third-party and
host-authored meta already registered rides on it.
**Instead.** The declaration is opt-in, and the shipped catalog takes it: all
nine metas `@orchestral/patterns` registers declare — the seven hand-written
pipelines, the via-caption fallback, and `meta_plan`, whose list is the DAG it
was handed — with a sweep over the registered catalog failing if a new one
forgets. A declaring meta's inner ids are held to the caller's allowlist,
blocklist and cycle check before anything is dispatched, and the refusal names
the offender in `via`, so the bypass is now exactly as wide as the metas that
stay silent. One level deep, though: a declared inner meta is judged on the id
it names, not on what that meta declares in turn.
**Where.** `packages/orchestral-runtime/src/agent-dispatch.ts` (DESIGN: planned-dispatches-guard);
`packages/orchestral-patterns/src/__tests__/meta-planned-dispatches.test.ts` (the catalog sweep);
`packages/orchestral-runtime/src/__tests__/agent-tool-guards.test.ts` ("leaves an UNDECLARED meta free to step outside the allowlist (status quo, pinned)").

### We don't namespace `job:step` ids or mint handles for inner plan steps
**Why.** Both are engine-wide changes with a one-line host workaround
(`childJobId`) and would make a plan more visible, not more correct.
Intermediate lineage stays a host concern; the plan's `output.assets` is the
model-facing surface.
**Instead.** Key a progress UI on `childJobId`; list what should be
addressable in the plan's `output` block.
**Where.** `packages/orchestral-runtime/src/inline.ts` (DESIGN: job-step-not-namespaced);
`packages/orchestral-runtime/src/meta-execution-context.ts` (DESIGN: step-id-namespace-nesting).

### We don't gate spend inside the plan interpreter
**Why.** The host decides on spend ("We don't impose concurrency caps,
timeouts, or TTLs"); `compose` has no router to show a model with, and an
`askUser` step would consume the step counter and park the job without replay.
**Instead.** `preflightPlan` routes every step and prices nothing — put its
report in front of your own `AskUserHandler` before `submitJob`; a hard cap is
a `beforeDispatch` middleware.
**Where.** `packages/orchestral-plan/src/preflight.ts` (DESIGN: preflight-prices-nothing);
`packages/orchestral-core/src/middleware.ts` (DESIGN: before-dispatch-hook).

## Things this document is not

- **Not a roadmap.** An entry says what the library declines today and why; it
  does not say what is planned.
- **Not a list of known bugs.** Fields that exist but are not acted on, lossy
  resume, the missing ffmpeg backend — those live in each package's
  `CHANGELOG.md` under "Known limitations".
- **Not permanent.** A refusal here is reversed by an argument that beats the
  stated one, not by a vote. When that happens, the entry comes out and the
  reasoning moves to the code that replaces it.
