import { atom } from 'nanostores'

/**
 * TURN STREAM STATS — the Reasonix-style "≈N tokens · M t/s" readout that
 * rides next to the working-status timer (2026-09-28 杨航 request).
 *
 * Token counts are only known to the backend at turn END (usage comes with
 * message.complete), so the live number is an ESTIMATE from streamed text
 * length — the same reason Reasonix prints "≈". The speed denominator is NOT
 * wall-clock elapsed: tool turns would drag it down. It only counts time
 * while output is actively flowing (deltas arriving in a continuous burst),
 * which is what "output speed" reads as.
 */
export interface TurnStreamStats {
  /** Characters streamed into the active session's assistant text this turn. */
  chars: number
  /** Of those, CJK characters (≈1.5 chars/token vs ≈4 for other scripts). */
  cjk: number
  /** Milliseconds during which those deltas actually arrived (burst time). */
  activeMs: number
}

export const $turnStreamStats = atom<TurnStreamStats>({ chars: 0, cjk: 0, activeMs: 0 })

let lastDeltaAt = 0

/** A new turn opens: zero the counters (active session only — background
 * rooms' turns must not clobber the visible readout). */
export function resetTurnStreamStats(): void {
  lastDeltaAt = 0
  $turnStreamStats.set({ chars: 0, cjk: 0, activeMs: 0 })
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x3ffff)
  )
}

/** Blended tokenizer estimate: CJK text runs ~1.5 chars/token, other scripts
 * ~4 chars/token. Honest enough for "≈", cheap enough to run per flush. */
export function estimateStreamTokens(stats: TurnStreamStats): number {
  const other = stats.chars - stats.cjk

  return Math.round(stats.cjk / 1.5 + other / 4)
}

/** One text delta landed on the ACTIVE session's stream. */
export function noteTurnStreamText(text: string): void {
  if (!text) {
    return
  }

  let cjk = 0

  for (const ch of text) {
    if (isCjkCode(ch.codePointAt(0) ?? 0)) {
      cjk++
    }
  }

  const now = performance.now()
  const prev = $turnStreamStats.get()

  // Burst accounting: a gap since the previous delta counts toward "actively
  // streaming" only when it is short (<1.5s) — tool round-trips pause the
  // denominator instead of diluting the rate. Cap each gap's contribution at
  // 200ms so a flush-throttled burst can't inflate it either.
  let burstMs = 0

  if (lastDeltaAt !== 0 && now - lastDeltaAt < 1500) {
    burstMs = Math.min(Math.max(now - lastDeltaAt, 0), 200)
  }

  lastDeltaAt = now
  $turnStreamStats.set({
    chars: prev.chars + text.length,
    cjk: prev.cjk + cjk,
    activeMs: prev.activeMs + burstMs
  })
}
