---
'@orchestral/core': minor
---

**Breaking.** `resolveSlashDispatch`, `SlashDispatchError` and
`SlashDispatchResolution` are gone. `resolveDispatchTarget(registry, input,
'slash')` was already the same gate — `resolveExposure(...).slash`, fail-closed
— and now also accepts an unqualified short name, which was the one thing the
slash module added. Two paths meant two error vocabularies for one refusal:
`SLASH_NOT_EXPOSED` or `PATTERN_NOT_DISPATCHABLE` depending on which entry point
a host happened to call.

Migration: replace `resolveSlashDispatch(registry, id)` with
`resolveDispatchTarget(registry, { pattern_id: id, input }, 'slash')`. It
validates the input too, and returns the Pattern rather than just its id
(`target.pattern.id` is the canonical full id). Map the codes as
`SLASH_PATTERN_NOT_FOUND` → `PATTERN_NOT_FOUND`, `SLASH_NOT_EXPOSED` →
`PATTERN_NOT_DISPATCHABLE`.

Short-name resolution now applies to every audience, not just slash: which
spelling of an id arrived is orthography, not a surface. `PATTERN_NOT_FOUND`'s
message says so (`… is not registered (tried full id and short name).`), and its
`hint` no longer points a person-facing surface at `find_pattern` — a tool the
person never called.
