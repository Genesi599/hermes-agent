import { useEffect } from 'react'

import { listAllProfileSessions } from '@/hermes'
import {
  $gatewayState,
  $selectedStoredSessionId,
  $sessions,
  $unreadFinishedSessionIds,
  clearSessionUnread,
  clearUnreadSessionIds
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

type SetTaskbarBadgeCount = (count: number) => void

type UnreadSessionRow = Pick<SessionInfo, 'archived' | 'id' | 'last_active' | 'started_at' | '_lineage_root_id'>

const UNREAD_RECONCILIATION_RETRY_MS = 2_500

export function subscribeTaskbarUnreadBadge(setBadgeCount?: SetTaskbarBadgeCount): () => void {
  if (!setBadgeCount) {
    return () => {}
  }

  return $unreadFinishedSessionIds.subscribe(sessionIds => setBadgeCount(sessionIds.length))
}

function sessionActivity(row: UnreadSessionRow): number {
  return Math.max(row.last_active ?? 0, row.started_at ?? 0)
}

function isNewerSession(candidate: UnreadSessionRow, current: UnreadSessionRow): boolean {
  const candidateActivity = sessionActivity(candidate)
  const currentActivity = sessionActivity(current)

  if (candidateActivity !== currentActivity) {
    return candidateActivity > currentActivity
  }

  return candidate.id > current.id
}

/**
 * Collapse persisted unread aliases to one current tip per compression
 * lineage. The sidebar intentionally deduplicates a compression chain, while
 * the durable unread store may still contain both the old and new stored IDs.
 */
export function canonicalUnreadSessionIds(
  unreadIds: readonly string[],
  sessions: readonly UnreadSessionRow[]
): string[] {
  const currentByLineage = new Map<string, UnreadSessionRow>()
  const byId = new Map<string, UnreadSessionRow>()

  for (const session of sessions) {
    const id = session.id.trim()

    if (!id || session.archived) {
      continue
    }

    const lineage = session._lineage_root_id?.trim() || id
    byId.set(id, session)

    const current = currentByLineage.get(lineage)

    if (!current || isNewerSession(session, current)) {
      currentByLineage.set(lineage, session)
    }
  }

  const canonicalIds: string[] = []
  const seenLineages = new Set<string>()

  for (const rawId of unreadIds) {
    const id = rawId.trim()
    const direct = byId.get(id)
    const lineage = direct?._lineage_root_id?.trim() || direct?.id || id
    const current = currentByLineage.get(lineage)

    if (!current || seenLineages.has(lineage)) {
      continue
    }

    seenLineages.add(lineage)
    canonicalIds.push(current.id)
  }

  return canonicalIds
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export async function reconcileTaskbarUnreadSessions(): Promise<void> {
  const unreadIds = $unreadFinishedSessionIds.get()

  if (!unreadIds.length) {
    return
  }

  try {
    const { sessions } = await listAllProfileSessions(1_000, 0, 'include', 'recent', 'all')
    // Use one id per compression lineage. `mergeSessionPage` applies the same
    // rule to the sidebar, so the taskbar badge cannot count an old tip that
    // is no longer rendered as its own conversation.
    const canonicalIds = canonicalUnreadSessionIds(unreadIds, sessions)
    const staleIds = unreadIds.filter(sessionId => !canonicalIds.includes(sessionId))

    if (staleIds.length) {
      clearUnreadSessionIds(staleIds)
    }

    const remainingIds = $unreadFinishedSessionIds.get()

    if (!sameIds(remainingIds, canonicalIds)) {
      $unreadFinishedSessionIds.set(canonicalIds)
    }
  } catch {
    // Keep persisted unread state when the session list is temporarily unavailable.
  }
}

export function subscribeSelectedSessionRead(): () => void {
  return $selectedStoredSessionId.subscribe(clearSessionUnread)
}

function sessionMembershipSignature(): string {
  const ids = new Set<string>()

  for (const session of $sessions.get()) {
    ids.add(session.id)

    if (session._lineage_root_id) {
      ids.add(session._lineage_root_id)
    }
  }

  return [...ids].sort().join('\0')
}

/** Revalidate durable unread ids when a background merge/delete changes the
 * session list, or when a turn first becomes unread. Metadata-only list polls
 * keep the same signature and do not add another backend request. */
export function subscribeUnreadSessionReconciliation(
  reconcile: () => Promise<void> = reconcileTaskbarUnreadSessions
): () => void {
  let previousMembership = sessionMembershipSignature()
  let previousUnread = new Set($unreadFinishedSessionIds.get())
  let queued = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const queueReconcile = () => {
    if (queued) {
      return
    }

    queued = true
    queueMicrotask(() => {
      queued = false
      void reconcile()
    })
  }

  const scheduleRetry = () => {
    if (retryTimer !== null) {
      return
    }

    retryTimer = setTimeout(() => {
      retryTimer = null

      if ($unreadFinishedSessionIds.get().length) {
        queueReconcile()
      }
    }, UNREAD_RECONCILIATION_RETRY_MS)
  }

  const unsubscribeSessions = $sessions.subscribe(() => {
    const membership = sessionMembershipSignature()

    if (membership === previousMembership) {
      return
    }

    previousMembership = membership

    if ($unreadFinishedSessionIds.get().length) {
      queueReconcile()
    }
  })

  const unsubscribeUnread = $unreadFinishedSessionIds.subscribe(sessionIds => {
    const current = new Set(sessionIds)
    const added = sessionIds.some(id => !previousUnread.has(id))
    previousUnread = current

    if (added) {
      queueReconcile()
      // A branch can finish before its deferred merge deletes the stored row.
      // Recheck once after that ordering window so the deleted child cannot
      // leave an invisible unread id behind in the taskbar badge.
      scheduleRetry()
    }
  })

  return () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
    }

    unsubscribeSessions()
    unsubscribeUnread()
  }
}

export function useTaskbarUnreadBadge() {
  useEffect(() => {
    const unsubscribeBadge = subscribeTaskbarUnreadBadge(window.hermesDesktop?.setTaskbarBadgeCount)
    const unsubscribeSelected = subscribeSelectedSessionRead()
    const unsubscribeReconciliation = subscribeUnreadSessionReconciliation()

    const unsubscribeGateway = $gatewayState.subscribe(state => {
      if (state === 'open') {
        void reconcileTaskbarUnreadSessions()
      }
    })

    void reconcileTaskbarUnreadSessions()

    return () => {
      unsubscribeBadge()
      unsubscribeSelected()
      unsubscribeReconciliation()
      unsubscribeGateway()
    }
  }, [])
}
