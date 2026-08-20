# @orchestral/discovery

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Part of the [Orchestral monorepo](https://github.com/orchestral-media/orchestral)
— see the repo README for how the packages fit together.

The **LLM discovery layer** for an Orchestral Pattern catalog: a BM25 search
index over a `PatternRegistry`, and the `find_pattern` tool handler that turns
a model's free-form query into a ranked, filtered, schema-carrying shortlist.

```sh
npm install @orchestral/discovery @orchestral/core zod
```

You usually get this transitively — `@orchestral/runtime` depends on it and
wires `find_pattern` into the agent loop for you. Install it directly when you
drive the loop yourself.

## Why this is not in core

`@orchestral/core` is the contract: `Pattern` / `ModelCapability` /
`Alternative`, the registry, the `Job` and `Runtime` interfaces. Retrieval is
not a contract — it is a product decision, and a replaceable one. A host that
outgrows lexical search swaps in embeddings, a hosted search service, or a
hand-written router without touching the vocabulary its Patterns are written
in, and every host that never exposes a catalog to an LLM stops paying for a
search dependency it does not use.

The split falls on the tool-call boundary:

| Concern | Package |
| --- | --- |
| `FindPatternInputSchema` — the find_pattern wire contract | `@orchestral/core` |
| `buildCatalogDescriptors` — renders the tool definition from that schema | `@orchestral/core` |
| `PatternSearchIndex` / `handleFindPattern` — answering a validated call | `@orchestral/discovery` |

So core still knows what a `find_pattern` call looks like and can validate one;
it just has no opinion on how the catalog gets searched.

The index reads the registry through its public accessors (`values`, `get`,
`resolveShortName`, `byNamespace`, `getEntry`) — the dependency runs one way,
and core has no idea this package exists.

## Usage

```ts
import { PatternRegistry, FindPatternInputSchema } from '@orchestral/core'
import { PatternSearchIndex, handleFindPattern } from '@orchestral/discovery'

const index = new PatternSearchIndex(registry)

// In your tool-call handler, after the LLM emits find_pattern({...}):
const parsed = FindPatternInputSchema.safeParse(toolInput)
if (!parsed.success) return { error: 'INVALID_INPUT', issues: parsed.error.issues }

const result = handleFindPattern(index, parsed.data, {
  router,          // drops atomics whose modelTags no provider can satisfy
  audience: 'chat-turn',
  k: 5,
})
```

`handleFindPattern` is a pure function — it returns a `FindPatternResult` and
the caller decides how to wrap it into a tool_result block. When nothing
matches, `result.diagnostic` breaks down where candidates were dropped
(modality / exposure / host-only / satisfiability) and carries a suggestion,
so the model can correct its next query instead of staring at an empty list.

Rebuild the index after the registry mutates:

```ts
registry.register(pattern)
index.rebuild(registry)
```

## What's in the box

- **`PatternSearchIndex`** — BM25 over minisearch, indexing tool descriptions,
  `searchHint`, id tokens and slot vocabulary. Mixed-script tokenizer so CJK
  queries match CJK catalog text. `search` / `applyFilter` / `matchesFilter`
  plus registry pass-throughs (`getById`, `resolveShortName`, `byNamespace`,
  `byPrefix`, `getEntry`) and a `skipped` diagnostic for patterns it could not
  index.
- **`handleFindPattern`** — selector shortcuts (`select:<id>`,
  `namespace:<ns>`, `<prefix>*`, bare id) ahead of BM25, then the shared
  post-rank filter loop: modality, per-audience exposure, host-only agents, and
  router satisfiability. Renders each survivor's primary tool description,
  derived input schema, and a compact outputs summary.
- **`DEFAULT_SEARCH_K`** — the shared default (5) so index and handler cannot
  drift.

## Versioning (0.x SemVer)

Pre-1.0: per SemVer's 0.x rule, **minor releases may contain breaking
changes**. Pin `"~0.1"` for patch-only updates. Breaking changes are documented
in `CHANGELOG.md`.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
