---
'@orchestral/core': minor
---

**Breaking.** `PatternRegistry.listForCatalog()` is removed. It was public API
with no caller in this repo, and it silently returned atomics only — a filter
neither its name nor its signature mentioned. The replacement is one line that
shows the filter: `[...registry].filter((p) => p.kind === 'atomic')`. Catalog
rendering for an LLM was never this method's job (`buildCatalogDescriptors`),
and neither was retrieval (`PatternSearchIndex` in `@orchestral/discovery`).

**Breaking.** `PatternRegistry.add()` is removed too; call `register()`. The
`spec.alternatives` expansion `add` was named for moved into `register` some
time ago, leaving two names for one entry point and a class doc still describing
a layer between them. `PatternScope.add` is unaffected — that one is the scope's
own verb, not an alias.

`idCarriesKind` had two JSDoc blocks stacked in front of it, of which TypeScript
read only the second; they are merged.
