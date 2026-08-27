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
(`OUTPUT_SCHEMA_MISMATCH`); an agent failure tool-result carries
`produced_handles` instead of raw asset ids. Single sources reclaimed:
`toJsonSchema` is the only outbound zod→JSON Schema edge (guarded by a static
test), handle minting and subagent-blocklist matching are single functions,
the orchestrator derives its tool list from the patterns package instead of a
hand copy, and `buildAgentInlineCore` now takes the owner pattern id and fails
loudly on allowlisted ids missing from the registry (signature change). AI SDK adapters fail loudly on unsupported asset slots and no longer
lose providerOptions under namespaced or relayed provider ids. DESIGN.md
citations are now anchors verified by a static test.
