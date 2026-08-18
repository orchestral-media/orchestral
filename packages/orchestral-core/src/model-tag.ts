/**
 * Capability sub-mode tags attached to a ModelCapability. NOT new Capability
 * values — these are routing-time *hints* that PrimaryPath and Pattern
 * alternatives use to prefer certain models within a satisfied capability.
 *
 * `PrimaryPath.modelTags` declares what the primary dispatch path needs
 * from a backing model. The Router intersects the candidate set with the
 * tag requirements and ranks by ResolveContext preferences.
 *
 * The open `(string & {})` tail lets host code introduce private tags
 * without modifying this package; built-in literals still autocomplete.
 *
 * Capability sub-modes (identity preservation / inpaint / voice-clone /
 * end-frame conditioning / ...) are deliberately NOT tags — they are
 * expressed by `input.references` asset slots + the provider's
 * self-reported typed `providerOptions` schema, not by router-time tag
 * matching. Tags stay *cross-cutting tier / capability flags* that matter
 * for PrimaryPath routing (one model family vs another):
 * tier (`fast-distilled` / `fast` / `balanced` / `premium`) +
 * generic LLM capabilities (`streaming` / `tool-use` / `structured-output`).
 */
export type ModelTag =
  // ── Tier / speed ────────────────────────────────────────────────────────
  /** Sub-second / step-distilled inference (distilled / few-step models). */
  | 'fast-distilled'
  /** Generic latency tiers (also expressed on ModelCapability.tier). */
  | 'fast'
  | 'balanced'
  | 'premium'

  // ── Generic agent capabilities ─────────────────────────────────────────
  | 'streaming'
  | 'tool-use'
  | 'structured-output'

  | (string & {})
