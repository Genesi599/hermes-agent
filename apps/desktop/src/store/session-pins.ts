import type { SessionInfo } from '@/types/hermes'

import { $pinnedSessionIds, pinSessions, unpinSessions } from './layout'
import { $sessions, sessionPinId } from './session'

function normalizedId(id: null | string | undefined): string {
  return id?.trim() ?? ''
}

/** Resolve one Branch tree to durable pin ids, ordered parent before children. */
export function sessionFamilyPinIds(sessions: readonly SessionInfo[], sessionId: string): string[] {
  const requestedId = normalizedId(sessionId)

  if (!requestedId) {
    return []
  }

  const byAnyId = new Map<string, SessionInfo>()

  for (const session of sessions) {
    byAnyId.set(session.id, session)

    if (session._lineage_root_id) {
      byAnyId.set(session._lineage_root_id, session)
    }
  }

  const target = byAnyId.get(requestedId)
  const targetPinId = target ? sessionPinId(target) : requestedId
  const parentByChild = new Map<string, string>()
  const childrenByParent = new Map<string, string[]>()
  const neighbors = new Map<string, Set<string>>()

  const connect = (left: string, right: string) => {
    if (!neighbors.has(left)) {
      neighbors.set(left, new Set())
    }

    if (!neighbors.has(right)) {
      neighbors.set(right, new Set())
    }

    neighbors.get(left)?.add(right)
    neighbors.get(right)?.add(left)
  }

  for (const session of sessions) {
    const childPinId = sessionPinId(session)
    const parentStoredId = normalizedId(session.parent_session_id)

    if (!parentStoredId) {
      continue
    }

    const parent = byAnyId.get(parentStoredId)
    const parentPinId = parent ? sessionPinId(parent) : parentStoredId

    if (childPinId === parentPinId) {
      continue
    }

    parentByChild.set(childPinId, parentPinId)
    childrenByParent.set(parentPinId, [...(childrenByParent.get(parentPinId) ?? []), childPinId])
    connect(childPinId, parentPinId)
  }

  const family = new Set<string>([targetPinId])
  const queue = [targetPinId]

  while (queue.length > 0) {
    const current = queue.shift()

    if (!current) {
      continue
    }

    for (const related of neighbors.get(current) ?? []) {
      if (!family.has(related)) {
        family.add(related)
        queue.push(related)
      }
    }
  }

  const roots = [...family].filter(id => !family.has(parentByChild.get(id) ?? ''))
  const ordered: string[] = []
  const visited = new Set<string>()

  const visit = (id: string) => {
    if (visited.has(id) || !family.has(id)) {
      return
    }

    visited.add(id)
    ordered.push(id)

    for (const childId of childrenByParent.get(id) ?? []) {
      visit(childId)
    }
  }

  for (const root of roots) {
    visit(root)
  }

  for (const id of family) {
    visit(id)
  }

  return ordered
}

export function expandPinnedSessionFamilies(
  sessions: readonly SessionInfo[],
  pinnedSessionIds: readonly string[]
): string[] {
  const expanded: string[] = []
  const seen = new Set<string>()

  for (const pinnedId of pinnedSessionIds) {
    for (const familyId of sessionFamilyPinIds(sessions, pinnedId)) {
      if (!seen.has(familyId)) {
        seen.add(familyId)
        expanded.push(familyId)
      }
    }
  }

  return expanded
}

/** Resolve runtime/unread stored ids to every visible member of each matching
 * Branch family. The returned ids are live row ids, ready for sidebar filters. */
export function expandSessionFamilyMemberIds(
  sessions: readonly SessionInfo[],
  sessionIds: readonly string[]
): Set<string> {
  const familyPinIds = new Set<string>()

  for (const sessionId of sessionIds) {
    for (const familyPinId of sessionFamilyPinIds(sessions, sessionId)) {
      familyPinIds.add(familyPinId)
    }
  }

  return new Set(sessions.filter(session => familyPinIds.has(sessionPinId(session))).map(session => session.id))
}

export function isSessionFamilyPinned(
  sessionId: string,
  sessions: readonly SessionInfo[] = $sessions.get(),
  pinnedSessionIds: readonly string[] = $pinnedSessionIds.get()
): boolean {
  const pinned = new Set(pinnedSessionIds)

  return sessionFamilyPinIds(sessions, sessionId).some(id => pinned.has(id))
}

export function pinSessionFamily(sessionId: string): void {
  pinSessions(sessionFamilyPinIds($sessions.get(), sessionId))
}

export function unpinSessionFamily(sessionId: string): void {
  unpinSessions(sessionFamilyPinIds($sessions.get(), sessionId))
}

export function toggleSessionFamilyPin(sessionId: string): void {
  if (isSessionFamilyPinned(sessionId)) {
    unpinSessionFamily(sessionId)
  } else {
    pinSessionFamily(sessionId)
  }
}
