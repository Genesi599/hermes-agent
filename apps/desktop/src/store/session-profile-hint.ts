import { atom } from 'nanostores'

/**
 * SESSION-PROFILE HINT — stored session id → the profile that owns it.
 *
 * The roster watches already KNOW which conversation belongs to which agent
 * profile (each watch polls one profile and publishes its session id). Yet
 * opening that conversation re-derived ownership through the cross-profile
 * probe ladder — paying misses for every profile ahead of it (plotter sits
 * 9th). The hint lets `resolveStoredSession` fire ONE scoped GET instead of
 * the whole ladder; a stale hint simply 404s and the normal resolution path
 * takes over.
 *
 * Written by the agent-activity poll (every roster, every 10s); read at
 * session-open time. Leaf module on purpose — writer and resolver both
 * import it, so it must not import either.
 */
export const $profileBySessionId = atom<Readonly<Record<string, string>>>({})

export function rememberSessionProfile(sessionId: string, profile: string): void {
  const id = sessionId.trim()
  const owner = profile.trim()

  if (!id || !owner) {
    return
  }

  const current = $profileBySessionId.get()

  if (current[id] === owner) {
    return
  }

  $profileBySessionId.set({ ...current, [id]: owner })
}
