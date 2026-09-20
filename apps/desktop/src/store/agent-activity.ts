import { atom } from 'nanostores'

import { listAllProfileSessions } from '@/hermes'
import { persistentAtom } from '@/lib/persisted'
import { $selectedStoredSessionId, markSessionUnread } from '@/store/session'

/**
 * AGENT ACTIVITY — how each agent's own conversation is doing, for the sidebar
 * roster chips.
 *
 * A chip is not a session row: the agent lives in ANOTHER profile, and its
 * conversation is usually never resumed in this window, so none of the local
 * status atoms (`$workingSessionIds`, `$unreadFinishedSessionIds`) can see it.
 * The one durable signal that crosses profiles is the backend's own
 * `live_status` on the session row (`working` / `idle`) — the same field the
 * contrib wiring turns into a synthetic busy state for un-resumed sessions. So
 * the roster polls each agent's newest conversation and derives the two things
 * a user reads off a row anyway: is it producing, and did it finish while they
 * were looking elsewhere.
 */

export type AgentRunStatus = 'idle' | 'working'

export interface AgentActivity {
  /** The agent's conversation this status belongs to. */
  sessionId: string
  status: AgentRunStatus
}

/** Keyed by agent profile. Absent = nothing known yet (chip shows its resting
 *  look — the same as an idle row, which is also unmarked). */
export const $agentActivity = atom<Record<string, AgentActivity>>({})

/** profile → when we last saw that agent finish. Persisted, because "finished
 *  while you were away" has to survive a restart to be an honest dot. */
export const $agentUnreadAt = persistentAtom<Record<string, number>>('hermes.desktop.agentUnreadAt.v1', {})


// ---------------------------------------------------------------------------
// GLOBAL POLL DRIVER (2026-09-20): the per-component useEffect loop proved
// dead in production (chips mounted, inputs verified working, zero polls).
// Polling now lives at module scope: rosters REGISTER watches, one shared
// interval drives them all — independent of component effect lifecycles.
// ---------------------------------------------------------------------------
const registeredWatches = new Map<string, AgentWatch>()
let pollTimer: null | number = null
let pollInFlight = false

const GLOBAL_POLL_MS = 10_000

async function runGlobalPoll(): Promise<void> {
  if (pollInFlight || document.hidden || registeredWatches.size === 0) {
    return
  }

  pollInFlight = true

  try {
    for (const watch of registeredWatches.values()) {
      await pollAgentWatch(watch)
    }
  } finally {
    pollInFlight = false
  }
}

function ensurePollTimer(): void {
  if (pollTimer !== null || typeof window === 'undefined') {
    return
  }

  pollTimer = window.setInterval(() => void runGlobalPoll(), GLOBAL_POLL_MS) as unknown as number
  void runGlobalPoll()
}

/** A roster registers the conversations its chips report on (keyed by watch
 *  key — re-registering the same watch refreshes it in place). */
export function registerAgentWatch(watch: AgentWatch): () => void {
  registeredWatches.set(agentWatchKey(watch), watch)
  ensurePollTimer()

  return () => {
    registeredWatches.delete(agentWatchKey(watch))
  }
}
/** The user has looked at this agent: drop the unread mark. */
export function markAgentRead(profile: string): void {
  const unread = $agentUnreadAt.get()

  if (!(profile in unread)) {
    return
  }

  const next = { ...unread }
  delete next[profile]
  $agentUnreadAt.set(next)
}

export interface AgentWatch {
  /** How to find the conversation to watch (newest, or by title prefix). */
  profile: string
  titlePrefix?: string
  /**
   * The PROJECT ROOM session this chip's roster hangs under (2026-09-20 杨航
   * rule): when an agent finishes a turn it speaks in the group room — the
   * unread dot belongs on the ROOM row (where the message landed), not on the
   * agent's chip. Absent = a bare-agent context with no room: the chip keeps
   * the legacy self-dot.
   */
  roomSessionId?: string
}

/** The store key for a watch. PROFILE ALONE IS NOT ENOUGH: every room's
 *  Hermes chip watches the default profile (one conversation per project, by
 *  title prefix), and keying by profile made them share ONE activity entry —
 *  a routing turn in one project lit the Hermes chip on every room's roster
 *  (2026-09-18). Agents keep the bare profile key (one conversation each). */
export function agentWatchKey(watch: { profile: string; titlePrefix?: string }): string {
  return watch.titlePrefix ? `${watch.profile}::${watch.titlePrefix}` : watch.profile
}

interface PolledSession {
  id?: null | string
  status?: null | string
  title?: null | string
  live_status?: null | string
  live_status_updated_at?: null | number
}

/** Stale window mirroring the backend's SESSION_LIVE_STALE_SECONDS. */
const LIVE_STATUS_STALE_SECONDS = 10 * 60

/** True when the row's working lease is live (set + fresh). The backend's
 *  `status` field never carries the lease (it serializes null — the chip's
 *  `status === 'working'` never fired, so the running animation NEVER lit);
 *  `live_status` + `live_status_updated_at` do. */
function workingLeaseLive(session: PolledSession, nowMs: number): boolean {
  if (session.live_status !== 'working') {
    return false
  }

  const updatedAt = Number(session.live_status_updated_at || 0)

  return nowMs / 1000 - updatedAt <= LIVE_STATUS_STALE_SECONDS
}

/** The session a chip should report on: its newest, or the newest whose title
 *  starts with the given prefix (Hermes's own project conversation). */
export function pickWatchedSession(
  sessions: PolledSession[],
  titlePrefix: string | undefined,
  nowMs: number = Date.now()
): null | { id: string; status: AgentRunStatus } {
  const match = titlePrefix
    ? sessions.find(session =>
        String(session.title ?? '')
          .trim()
          .startsWith(titlePrefix)
      )
    : sessions[0]

  if (!match || !match.id) {
    return null
  }

  return {
    id: String(match.id),
    status: workingLeaseLive(match, nowMs) ? 'working' : 'idle'
  }
}

/** One poll for one watch: read the agent's newest conversation (or the one
 *  matching `titlePrefix`), publish its status, and turn a working→idle
 *  transition into an unread mark. */
export async function pollAgentWatch(watch: AgentWatch): Promise<void> {
  const limit = watch.titlePrefix ? 50 : 1

  try {
    const { sessions } = await listAllProfileSessions(limit, 0, 'exclude', 'recent', watch.profile)

    const picked = pickWatchedSession(
      sessions.map(session => ({ id: session.id, status: session.status, title: session.title, live_status: session.live_status, live_status_updated_at: session.live_status_updated_at })),
      watch.titlePrefix
    )

    if (!picked) {
      return
    }

    const key = agentWatchKey(watch)
    const previous = $agentActivity.get()[key]

    // TEMP DEBUG (2026-09-20): the plotter chip stays idle while every input
    // verifies working — log the poll's verdict to find the dead hop.
    console.warn(`[agent-poll] key=${key} status=${picked.status}`)

    $agentActivity.set({
      ...$agentActivity.get(),
      [key]: { sessionId: picked.id, status: picked.status }
    })

    // A turn that finishes while its own conversation is the one on screen is
    // not "unread" — the user watched it land. Only a finish they were looking
    // AWAY from earns the dot.
    if (previous?.status === 'working' && picked.status === 'idle') {
      // Room roster (project group chat): the finished turn is DELIVERED to
      // the room — the unread dot moves to the room row, not this chip. "Seen"
      // means the ROOM was on screen when it landed.
      const room = watch.roomSessionId?.trim()

      if (room) {
        if (room !== $selectedStoredSessionId.get()) {
          markSessionUnread(room)
        }
      } else if (picked.id !== $selectedStoredSessionId.get()) {
        $agentUnreadAt.set({ ...$agentUnreadAt.get(), [key]: Date.now() })
      }
    }
  } catch {
    // A poll that fails changes nothing: the chip keeps its last known state.
  }
}
