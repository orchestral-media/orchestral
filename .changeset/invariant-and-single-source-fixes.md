---
"@orchestral/core": minor
"@orchestral/runtime": minor
"@orchestral/patterns": minor
"@orchestral/adapters-ai-sdk": minor
"@orchestral/agent": minor
"@orchestral/discovery": minor
---

Enforcement now matches the argued design: `buildAlwaysLoadDescriptors` filters
through `resolveExposure` before reading `exposureMode`; middleware
short-circuit outputs pass the same exit gate as adapter outputs
(`OUTPUT_SCHEMA_MISMATCH`), whatever the Pattern's kind — no finish tool ran
there, so a supplied value answers for itself, and a cache entry the schema now
rejects fails loudly instead of being served; an agent failure tool-result
carries `produced_handles` instead of raw asset ids. Single sources reclaimed:
`toJsonSchema` is the only outbound zod→JSON Schema edge (guarded by a static
test), handle minting and subagent-blocklist matching are single functions,
the orchestrator derives its tool list from the patterns package instead of a
hand copy, and `buildAgentInlineCore` now takes the owner pattern id and fails
loudly on allowlisted ids missing from the registry (internal signature
change — it is not on the `@orchestral/runtime` barrel). AI SDK adapters fail
loudly on unsupported asset slots and no longer lose providerOptions under
namespaced or relayed provider ids. DESIGN.md citations are now anchors
verified by a static test.

**The per-Pattern opt-out from the sub-agent blocklist is gone.** The blocklist
beat `loop.toolPatternIds` at dispatch already; it now beats it at the catalog
too, so an `agent_` id an author lists is skipped when the inline core is built
rather than rendered as a tool whose every call comes back `SUBAGENT_BLOCKED`.
Listing one was never a widening — it was a way to advertise a tool that did
not work — and the catalog and the call side now say the same sentence.
Opening recursion means overriding `DEFAULT_SUBAGENT_BLOCKLIST` itself, which
is the honest place to argue for it: one decision, visible at the seam that
enforces it, instead of per-Pattern grants that only look like permission.

**New error codes.** `AGENT_TOOL_PATTERN_NOT_REGISTERED` fails an agent
dispatch whose `loop.toolPatternIds` names ids the registry does not have —
before the loop starts, since an unsatisfiable allowlist is an authoring error
and nothing has been dispatched yet to pay for it. `ASSET_SLOT_NOT_SUPPORTED`
is the loud half of the adapter change above: a slot the adapter cannot send is
refused by name instead of being dropped on the way to the provider.
`NO_SOURCE_ASSET` and
`SOURCE_ASSET_NOT_LOADED` on the `automatic-speech-recognition` path are now
carried as `code` on the thrown error, not just spelled in its message, so a
host narrows on them the way it narrows on every other orchestral failure.

**New public exports**, all additive:

- `matchSubagentBlocklist` and the `SubagentBlocklist` type
  (`@orchestral/core`) — the one matcher both the catalog and the call guard
  ask, so a host that wants to predict a refusal asks it too rather than
  re-implementing the prefix rule.
- `buildAlwaysLoadDescriptors` takes a `surface` option (`@orchestral/core`):
  `'chatTurn'` (default, unchanged) or `'agentLoop'`, so a sub-agent's inline
  core admits an `exposure: 'agent-tool'` Pattern and excludes a chat-only one.
- `FIRST_PARTY_PATTERN_IDS` (`@orchestral/patterns`) — the shipped id catalog
  as data, grouped by declared kind. This is what ended the orchestrator's hand
  copy; a host registering a subset can read it too.
- `ORCHESTRATOR_DEFAULT_PROMPTS`, `OrchestratorAgentInit`,
  `OrchestratorPromptOverrides`, and a widened
  `createOrchestratorAgent(init?)` (`@orchestral/agent`) — prompt body, tool
  universe and abort mode are defaults this package picked on your behalf, and
  the alternative to overriding them was forking a package whose entire content
  is one declaration. The no-argument call is unchanged.
- `AgentAssetBridge.handlesFor` (`@orchestral/runtime`) — optional, so an
  existing bridge still type-checks. Implement it and a failed child dispatch
  reports its partial work as handles the loop can cite; leave it out and the
  loop is told a count, as before.

**`agent_orchestrator` no longer declares `loop.asyncToolPatternIds`.** It has
one tool universe on purpose. The field prunes the catalog to
`toolPatternIds ∩ asyncToolPatternIds` and only when `defaultExecutionMode` is
`'async'`, which this pattern never set — so the declaration bought no
behaviour and was a second list to keep in sync.

**`image-to-text`: an unknown `mode` no longer throws.** The AI SDK vision
adapter keeps a copy of the pattern's `mode` enum (it does not depend on
`@orchestral/patterns`), and a mode with no entry there is now a mode it has no
default instruction for and nothing more: the call runs with no system text,
exactly as it does when the caller passes a `prompt`. This is the one place on
this branch where the change is toward silence rather than away from it, and
the reason is asymmetry — the failure it removes was "patterns added a word" to
becoming a hard outage in every host wrapping this adapter, for a mode whose
only effect is a sentence the caller could have written themselves. A test
asserts the table still covers the pattern's enum, so the drift shows up in CI
instead of in production.

**`@orchestral/agent` dropped its `@orchestral/runtime` dependency**, which it
did not use: the package is a pure declaration and the runtime is where the
agent seam lives, not where the Pattern is authored. If you were relying on the
transitive install to get `@orchestral/runtime`, add it to your own
dependencies — you were always the one constructing the runtime.
