---
"@orchestral/patterns": minor
---

Every meta in the shipped catalog now declares `MetaPattern.plannedDispatches` — the pattern ids its `compose` can dispatch, readable before it runs. The seven hand-written pipelines and the `via-caption` fallback join `meta_plan`, which already declared its step list:

- `meta_script2video` → `text-generation`, `text-to-image`, `image-to-image`, `image-to-video`
- `meta_storyboard` → `text-generation`, `image-to-image`, `meta_image-best-of-n`
- `meta_image-best-of-n` → the `innerPatternId` the caller passed (`text-to-image` or `image-to-image`), plus the `image-to-text` judge
- `meta_ugc-testimonial` → `text-generation`, `text-to-speech`, `text-to-image`, `image-to-video`, `automatic-speech-recognition`
- `meta_explainer-short` → `text-generation`, `text-to-image`, `text-to-speech`
- `meta_product-ad-short` → `text-generation`, `text-to-image`, `image-to-video`, `text-to-audio`
- `meta_product-photo-pack` → `text-generation`, `text-to-image`
- `meta_image-to-image-via-caption` → `image-to-text`, `text-to-image`

Host ops (`concatVideos`, `addSubtitles`, `stillToVideo`, `addBackgroundAudio`, …) are not dispatches and appear nowhere in these lists. No factory signature or return type changes.

**Minor rather than patch, because an agent host can see new refusals.** `@orchestral/runtime`'s agent guard holds a declaring meta's inner ids to the calling loop's `loop.toolPatternIds` — allowlist, blocklist and ancestor chain — before the child is submitted. A loop that lists a meta but not the patterns it is made of (`meta_script2video` without `text-to-image`, say) now gets `SUBAGENT_TOOL_OUT_OF_SCOPE` up front, with the offending id in `via`, where the same call previously slipped past the guard and ran. What these metas dispatch has not changed; what changed is that they say so in time to be checked. The CHANGELOGs promise "pin `~0.1` for patch-only updates", and a behavioural tightening must not ride a patch.

If an agent of yours dispatches one of these metas, widen its `loop.toolPatternIds` to include the ids above — granting the meta means granting what the meta is made of. Metas dispatched from a host, a chat turn, or another meta's `compose` are unaffected: the check lives on the agent-loop tool-call path and nowhere else.
