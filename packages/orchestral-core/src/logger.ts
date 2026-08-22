// Diagnostics seam. Anything that happens to a job is reported as a JobEvent
// on that job's stream — the channel a host already subscribes to. A handful
// of things have no job to report on, or fail while reporting: a host
// callback that threw (onJobCreated, middleware.onError, a subscriber), a
// transcript append that failed, a registration-time authoring lint. Those
// still have to go somewhere, and where is the host's call, not the library's:
// a CLI wants stderr, a desktop app wants its own log file, a test wants
// silence. This is the narrowest shape a host can adapt to, and deliberately
// not a logging framework — two levels, no formatting, no child loggers.

/**
 * Where the library sends diagnostics it cannot express as a JobEvent.
 *
 * `message` is a human-readable line that names what failed and for which
 * job; `detail` is whatever the library had in hand, usually the error a host
 * callback threw. The rule for what reaches this seam: if it belongs to a job
 * it is a JobEvent, never a log line.
 */
export interface DiagnosticsLogger {
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/**
 * Default: the host console. `detail` is forwarded only when one was given,
 * so a bare message reaches the console as a single argument — a host that
 * spies on `console.warn` sees exactly the line, not a trailing `undefined`.
 */
export const consoleDiagnosticsLogger: DiagnosticsLogger = {
  warn: (message, detail) =>
    detail === undefined ? console.warn(message) : console.warn(message, detail),
  error: (message, detail) =>
    detail === undefined ? console.error(message) : console.error(message, detail),
}

/** Discards everything — for tests and hosts with their own channel. */
export const silentDiagnosticsLogger: DiagnosticsLogger = {
  warn: () => undefined,
  error: () => undefined,
}
