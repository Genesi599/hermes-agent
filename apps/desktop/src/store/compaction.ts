import { atom, computed } from 'nanostores'

// Per-session flag while auto-compaction runs mid-turn. The value is the
// latest backend status text ('' when none arrived) so the status bar can
// show magnitude/progress instead of a fixed label. Without the flag the
// transcript looks like it reset; per-session so a background chat can't
// clobber the foreground view.
const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $compactingSessions = atom<Record<string, string>>({})

/** Is `sessionId` compacting? Per-session because a transcript may be a tile,
 *  and a tile must never wear the primary chat's compaction state. */
export function sessionCompacting(sessionId: null | string) {
  return computed($compactingSessions, sessions => keyFor(sessionId) in sessions)
}

/** Latest backend compaction status text for `sessionId` — '' when compacting
 *  without any text yet. Drives the live status-bar line (token counts,
 *  elapsed heartbeats) while `sessionCompacting` drives the boolean gates. */
export function sessionCompactingText(sessionId: null | string) {
  return computed($compactingSessions, sessions => sessions[keyFor(sessionId)] ?? '')
}

export function setSessionCompacting(
  sessionId: string | null | undefined,
  active: boolean,
  text?: unknown
): void {
  const key = keyFor(sessionId)
  const sessions = $compactingSessions.get()

  if (active) {
    const previous = sessions[key]

    // The backend re-emits the compacting status as it progresses (start
    // line, per-minute heartbeat); an empty/unset text means "no new line",
    // so keep whatever was last shown instead of blanking it.
    const value = typeof text === 'string' && text ? text : (previous ?? '')

    if (previous === value) {
      return
    }

    $compactingSessions.set({ ...sessions, [key]: value })

    return
  }

  if (!(key in sessions)) {
    return
  }

  const next = { ...sessions }
  delete next[key]
  $compactingSessions.set(next)
}
