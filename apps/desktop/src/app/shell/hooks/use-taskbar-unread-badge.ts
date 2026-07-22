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

type SetTaskbarBadgeCount = (count: number) => void

export function subscribeTaskbarUnreadBadge(setBadgeCount?: SetTaskbarBadgeCount): () => void {
  if (!setBadgeCount) {
    return () => {}
  }

  return $unreadFinishedSessionIds.subscribe(sessionIds => setBadgeCount(sessionIds.length))
}

export async function reconcileTaskbarUnreadSessions(): Promise<void> {
  const unreadIds = $unreadFinishedSessionIds.get()

  if (!unreadIds.length) {
    return
  }

  try {
    const { sessions } = await listAllProfileSessions(1_000, 0, 'include', 'recent', 'all')
    const existingIds = new Set<string>()

    for (const session of sessions) {
      if (session.archived) {
        continue
      }

      existingIds.add(session.id)

      if (session._lineage_root_id) {
        existingIds.add(session._lineage_root_id)
      }
    }

    clearUnreadSessionIds(unreadIds.filter(sessionId => !existingIds.has(sessionId)))
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
    }
  })

  return () => {
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
