// Binary scrubber for tool results on their way back into an LLM context
// (defense-in-depth).
//
// What it prevents: a Pattern's `outputs` schema is meant to carry
// LLM-consumable metadata only (asset references, cost, latency, URLs). When
// an author accidentally lands a `data:` URL or a raw byte field in the
// output, feeding it back verbatim burns the whole context window on
// unreadable bytes — and, once in history, on every subsequent turn. This
// sanitizer replaces such values with a marker before the tool result reaches
// the model.
//
// Strip rules:
//   - any string value starting with `data:` (data URL — base64 / utf-8)
//   - any string longer than `maxInlineLen` that *looks binary*:
//       · a contiguous base64/base64url/hex run ≥ `base64RunMin` chars
//         (bare base64 fields missing a `data:` prefix), or
//       · > `controlRatio` of control chars / U+FFFD (raw bytes coerced
//         into a string)
//   - applied recursively over nested objects + arrays
//
// Length alone is NOT a strip signal: legitimate long strings (pagination
// cursors, prose, URL lists) must survive. The discriminator is run length —
// natural text and JSON are broken up by spaces / structural punctuation
// every few dozen chars, while encoded binary runs uninterrupted for
// thousands. Legitimate opaque tokens (signed-URL signatures ~512 chars,
// JWT segments) stay well under the default `base64RunMin`. Known accepted
// gap: MIME/PEM-style base64 wrapped at 76 cols evades the run check — that
// shape requires deliberate formatting and doesn't occur in Pattern outputs;
// the primary defense remains a bounded `outputs` schema (see output-fields).
//
// Scope: this narrows only the copy handed to the model. The function returns
// a new value and never mutates its input, so callers keep the full original
// output for storage and UI rendering.

const STRIPPED_MARKER = '<binary stripped — reference via assetId>'

// C0 controls minus \t \n \r, plus U+FFFD (utf-8 decode damage).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is this regex's entire job
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g

export type StripReason = 'data-url' | 'binary-run' | 'control-chars'
/** Invoked synchronously per strip, on the critical sanitize path. Must not throw. */
export type OnStrip = (info: { path: string; reason: StripReason }) => void

export interface SanitizeToolOutputOptions {
  /** Notified once per stripped value. Must not throw. */
  onStrip?: OnStrip
  /** Strings at or below this length are never inspected for binary. Default 4096. */
  maxInlineLen?: number
  /** Shortest uninterrupted base64/hex run that marks a string binary. Default 1024. */
  base64RunMin?: number
  /** Control-char fraction above which a string counts as raw bytes. Default 0.02. */
  controlRatio?: number
}

const DEFAULT_MAX_INLINE_LEN = 4096
const DEFAULT_BASE64_RUN_MIN = 1024
const DEFAULT_CONTROL_RATIO = 0.02
const DEFAULT_BASE64_RUN = new RegExp(
  `[A-Za-z0-9+/=_-]{${DEFAULT_BASE64_RUN_MIN},}`,
)

interface Thresholds {
  maxInlineLen: number
  base64Run: RegExp
  controlRatio: number
}

export function sanitizeToolOutput<T>(
  output: T,
  options: SanitizeToolOutputOptions = {},
): T {
  const thresholds: Thresholds = {
    maxInlineLen: options.maxInlineLen ?? DEFAULT_MAX_INLINE_LEN,
    base64Run:
      options.base64RunMin === undefined
        ? DEFAULT_BASE64_RUN
        : new RegExp(`[A-Za-z0-9+/=_-]{${options.base64RunMin},}`),
    controlRatio: options.controlRatio ?? DEFAULT_CONTROL_RATIO,
  }
  return walk(output, '', thresholds, options.onStrip) as T
}

function binaryReason(value: string, t: Thresholds): StripReason | null {
  if (t.base64Run.test(value)) return 'binary-run'
  const controls = value.match(CONTROL_CHARS)?.length ?? 0
  return controls > value.length * t.controlRatio ? 'control-chars' : null
}

function walk(
  value: unknown,
  path: string,
  t: Thresholds,
  onStrip?: OnStrip,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      onStrip?.({ path, reason: 'data-url' })
      return STRIPPED_MARKER
    }
    if (value.length > t.maxInlineLen) {
      const reason = binaryReason(value, t)
      if (reason) {
        onStrip?.({ path, reason })
        return STRIPPED_MARKER
      }
    }
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value))
    return value.map((v, i) => walk(v, `${path}[${i}]`, t, onStrip))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, path ? `${path}.${k}` : k, t, onStrip)
  }
  return out
}
