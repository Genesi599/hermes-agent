// Backend subcommand routing for the desktop-managed Hermes process.
//
// The desktop app launches its own headless backend via `hermes serve` — it
// must NEVER depend on or launch the browser `dashboard`. But `serve` is a
// newer subcommand: a runtime that predates it (an older managed install the
// app hasn't updated yet, or an older `hermes` resolved from PATH) only knows
// `dashboard --no-open`. To avoid bricking those users mid-upgrade we detect
// whether the resolved runtime understands `serve` and, only when it does not,
// fall back to the legacy `dashboard --no-open` invocation. Both produce the
// exact same headless gateway; `serve` is just the decoupled name.
//
// These helpers are pure so they can be unit-tested without Electron.

/**
 * Build the canonical headless backend argv (always `serve`).
 * @param {string} [profile] optional Hermes profile to pin via `--profile`.
 * @param {string} [port] explicit listen port; `0` lets the OS choose one.
 */
export function serveBackendArgs(profile?: string, port = '0') {
  const head = profile ? ['--profile', profile] : []

  return [...head, 'serve', '--host', '127.0.0.1', '--port', port]
}

export function normalizeBackendPort(value: unknown): string {
  const text = String(value ?? '').trim()

  if (!/^\d+$/.test(text)) {
    return '0'
  }

  const port = Number(text)

  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? String(port) : '0'
}

/**
 * Rewrite a resolved backend argv from `serve` to the legacy
 * `dashboard --no-open` form, preserving every other argument (incl. a leading
 * `-m hermes_cli.main` and any `--profile <name>`). Returns a copy; if there is
 * no `serve` token the argv is returned unchanged.
 */
export function dashboardFallbackArgs(args) {
  const i = args.indexOf('serve')

  if (i === -1) {
    return args.slice()
  }

  return [...args.slice(0, i), 'dashboard', '--no-open', ...args.slice(i + 1)]
}

/**
 * True when a runtime's `hermes_cli/subcommands/dashboard.py` source registers
 * the `serve` subcommand. Matches `add_parser("serve"` / `add_parser('serve'`
 * specifically so the substring "server" (e.g. "start_server", "web server")
 * never produces a false positive.
 */
export function sourceDeclaresServe(dashboardPySource) {
  return /add_parser\(\s*["']serve["']/.test(String(dashboardPySource || ''))
}
