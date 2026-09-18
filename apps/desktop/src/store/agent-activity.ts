import { atom } from 'nanostores'

import { listAllProfileSessions } from '@/hermes'
import { persistentAtom } from '@/lib/persisted'
import { $selectedStoredSessionId } from '@/store/session'

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
}

/** The session a chip should report on: its newest, or the newest whose title
 *  starts with the given prefix (Hermes's own project conversation). */
export function pickWatchedSession(
  sessions: PolledSession[],
  titlePrefix: string | undefined
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

  return { id: String(match.id), status: match.status === 'working' ? 'working' : 'idle' }
}

/** One poll for one watch: read the agent's newest conversation (or the one
 *  matching `titlePrefix`), publish its status, and turn a working→idle
 *  transition into an unread mark. */
export async function pollAgentWatch(watch: AgentWatch): Promise<void> {
  const limit = watch.titlePrefix ? 50 : 1

  try {
    const { sessions } = await listAllProfileSessions(limit, 0, 'exclude', 'recent', watch.profile)

    const picked = pickWatchedSession(
      sessions.map(session => ({ id: session.id, status: session.status, title: session.title })),
      watch.titlePrefix
    )

    if (!picked) {
      return
    }

    const key = agentWatchKey(watch)
    const previous = $agentActivity.get()[key]

    $agentActivity.set({
      ...$agentActivity.get(),
      [key]: { sessionId: picked.id, status: picked.status }
    })

    // A turn that finishes while its own conversation is the one on screen is
    // not "unread" — the user watched it land. Only a finish they were looking
    // AWAY from earns the dot.
    if (previous?.status === 'working' && picked.status === 'idle' && picked.id !== $selectedStoredSessionId.get()) {
      $agentUnreadAt.set({ ...$agentUnreadAt.get(), [key]: Date.now() })
    }
  } catch {
    // A poll that fails changes nothing: the chip keeps its last known state.
  }
}
