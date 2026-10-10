---
'@orchestral/core': minor
'@orchestral/runtime': minor
'@orchestral/plan': minor
'@orchestral/patterns': minor
'@orchestral/adapters-ai-sdk': minor
'@orchestral/discovery': minor
'@orchestral/agent': minor
---

Every AI SDK adapter now refuses a resolved asset slot it does not send to the provider.

**Tightened (0.x, no shims):** `fromVisionModel`, `fromTranscriptionModel` and `fromLanguageModel` fail the call with `ASSET_SLOT_NOT_SUPPORTED` when it carries a resolved slot they do not map, before anything reaches the provider. Until now they ran the call and dropped the slot: a second slot beside image-to-text's or ASR's `source`, or any slot on a `text-generation` call, never reached the model, and nothing in the output said so. `fromImageModel` and `fromSpeechModel` already refused; the rule is now the same across all five. A host that relied on the silent drop removes the reference from the input, or wraps the adapter and sends the slot itself.

Two changes landing alongside this one are internal and change no behaviour: the runtime reads core's `JOB_TERMINAL_STATUSES` instead of its own copy of the terminal set, and `@orchestral/plan`'s two validation layers share one helper for a step's input schema.
