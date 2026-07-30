import { computed } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import { $sessions, sessionPinId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

// Per-conversation color overrides. They are keyed by the branch family's root
// so a chosen color applies to the parent and every branch, and survives
// auto-compression's session-id rotation.
export const $sessionColorOverrides = persistentAtom<Record<string, string>>(
  'hermes.desktop.sessionColors',
  {},
  Codecs.stringRecord
)

// Set a conversation family's override (null clears it → its automatic color).
export function setSessionColorOverride(durableId: string, color: null | string): void {
  const prev = $sessionColorOverrides.get()

  if (color) {
    $sessionColorOverrides.set({ ...prev, [durableId]: color })
  } else if (durableId in prev) {
    const next = { ...prev }
    delete next[durableId]
    $sessionColorOverrides.set(next)
  }
}

function sessionLookup(sessions: SessionInfo[]): Map<string, SessionInfo> {
  const lookup = new Map<string, SessionInfo>()

  for (const session of sessions) {
    lookup.set(session.id, session)
    lookup.set(sessionPinId(session), session)
  }

  return lookup
}

/**
 * Stable identity for a visible conversation tree. Branches inherit their
 * top-most parent's identity; compression continuations retain their own
 * lineage root. A missing ancestor still gives all of its direct children the
 * same deterministic key until the parent appears in a later page.
 */
export function sessionColorFamilyId(session: SessionInfo, sessions: SessionInfo[]): string {
  const lookup = sessionLookup(sessions)
  const lineage = [sessionPinId(session)]
  const visited = new Set<string>([session.id, sessionPinId(session)])
  let current = session

  while (current.parent_session_id) {
    const parentId = current.parent_session_id.trim()

    if (!parentId) {
      break
    }

    const parent = lookup.get(parentId)

    if (!parent) {
      return parentId
    }

    const parentKey = sessionPinId(parent)
    lineage.push(parentKey)

    if (visited.has(parent.id) || visited.has(parentKey)) {
      return [...lineage].sort()[0]
    }

    visited.add(parent.id)
    visited.add(parentKey)
    current = parent
  }

  return sessionPinId(current)
}

function automaticSessionColor(familyId: string): string {
  let hash = 2_166_136_261

  for (let index = 0; index < familyId.length; index += 1) {
    hash ^= familyId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  const unsigned = hash >>> 0
  const hue = unsigned % 360
  const saturation = 62 + ((unsigned >>> 9) % 3) * 5
  const lightness = 58 + ((unsigned >>> 17) % 3) * 4

  return `hsl(${hue} ${saturation}% ${lightness}%)`
}

// The resolved color for every session, keyed by live session id — the ONE
// source of truth both the sidebar rows and the pane tabs read, so the two
// surfaces can never drift. Recomputed only when the session list or overrides
// change (all cold atoms; the working/streaming pulse lives in
// $sessionStates, so a busy flip never rebuilds this), and every consumer reads
// it as an O(1) lookup rather than re-deriving membership per render.
//
// Every conversation tree receives a stable automatic color. An explicit family
// override wins; legacy per-session overrides are promoted to that family so
// old user choices keep their visible meaning without splitting a branch tree.
export const $sessionColorById = computed(
  [$sessions, $sessionColorOverrides],
  (sessions, overrides) => {
    const map: Record<string, string> = {}
    const familyBySessionId = new Map<string, string>()
    const overrideByFamily = new Map<string, string>()

    for (const session of sessions) {
      const familyId = sessionColorFamilyId(session, sessions)
      familyBySessionId.set(session.id, familyId)

      const override = overrides[familyId] ?? overrides[sessionPinId(session)]

      if (override && !overrideByFamily.has(familyId)) {
        overrideByFamily.set(familyId, override)
      }
    }

    for (const session of sessions) {
      const familyId = familyBySessionId.get(session.id) ?? sessionPinId(session)
      map[session.id] = overrideByFamily.get(familyId) ?? automaticSessionColor(familyId)
    }

    return map
  }
)

// The color for a single session object (the tabs already hold the SessionInfo
// they render, so they resolve through the same map the sidebar reads).
export function sessionColorFor(session: null | SessionInfo | undefined): string | undefined {
  return session ? $sessionColorById.get()[session.id] : undefined
}
