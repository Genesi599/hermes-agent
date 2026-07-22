import { afterEach, describe, expect, it, vi } from 'vitest'

import { listAllProfileSessions } from '@/hermes'
import { $selectedStoredSessionId, $unreadFinishedSessionIds, setSessions } from '@/store/session'

import {
  reconcileTaskbarUnreadSessions,
  subscribeSelectedSessionRead,
  subscribeTaskbarUnreadBadge,
  subscribeUnreadSessionReconciliation
} from './use-taskbar-unread-badge'

vi.mock('@/hermes', () => ({
  listAllProfileSessions: vi.fn()
}))

describe('subscribeTaskbarUnreadBadge', () => {
  afterEach(() => {
    $unreadFinishedSessionIds.set([])
    $selectedStoredSessionId.set(null)
    setSessions([])
    vi.clearAllMocks()
  })

  it('pushes the persisted unread count immediately and on every change', () => {
    $unreadFinishedSessionIds.set(['a', 'b'])
    const setBadgeCount = vi.fn()
    const unsubscribe = subscribeTaskbarUnreadBadge(setBadgeCount)

    expect(setBadgeCount).toHaveBeenLastCalledWith(2)

    $unreadFinishedSessionIds.set(['b'])
    expect(setBadgeCount).toHaveBeenLastCalledWith(1)

    $unreadFinishedSessionIds.set([])
    expect(setBadgeCount).toHaveBeenLastCalledWith(0)

    unsubscribe()
    $unreadFinishedSessionIds.set(['after-unsubscribe'])
    expect(setBadgeCount).toHaveBeenCalledTimes(3)
  })

  it('clears persisted ids that no longer exist in any profile', async () => {
    $unreadFinishedSessionIds.set(['deleted', 'live', 'archived'])
    vi.mocked(listAllProfileSessions).mockResolvedValue({
      sessions: [
        { archived: false, id: 'live' },
        { archived: true, id: 'archived' }
      ]
    } as never)

    await reconcileTaskbarUnreadSessions()

    expect(listAllProfileSessions).toHaveBeenCalledWith(1_000, 0, 'include', 'recent', 'all')
    expect($unreadFinishedSessionIds.get()).toEqual(['live'])
  })

  it('preserves state on transient session list errors', async () => {
    $unreadFinishedSessionIds.set(['live', 'unknown'])
    vi.mocked(listAllProfileSessions).mockRejectedValue(new Error('503: unavailable'))

    await reconcileTaskbarUnreadSessions()

    expect($unreadFinishedSessionIds.get()).toEqual(['live', 'unknown'])
  })

  it('marks the restored or selected session as read', () => {
    $unreadFinishedSessionIds.set(['current', 'other'])
    $selectedStoredSessionId.set('current')

    const unsubscribe = subscribeSelectedSessionRead()

    expect($unreadFinishedSessionIds.get()).toEqual(['other'])
    $selectedStoredSessionId.set('other')
    expect($unreadFinishedSessionIds.get()).toEqual([])
    unsubscribe()
  })

  it('reconciles unread ids after a background merge removes the child session', async () => {
    setSessions([{ id: 'branch-child', _lineage_root_id: 'branch-root' } as never])
    $unreadFinishedSessionIds.set(['branch-child'])
    vi.mocked(listAllProfileSessions).mockResolvedValue({ sessions: [] } as never)
    const unsubscribe = subscribeUnreadSessionReconciliation()

    setSessions([])
    await vi.waitFor(() => expect($unreadFinishedSessionIds.get()).toEqual([]))

    expect(listAllProfileSessions).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does not reconcile when a session poll only changes metadata', async () => {
    setSessions([{ id: 'live', title: 'Before' } as never])
    $unreadFinishedSessionIds.set(['live'])
    const reconcile = vi.fn(async () => undefined)
    const unsubscribe = subscribeUnreadSessionReconciliation(reconcile)

    setSessions([{ id: 'live', title: 'After' } as never])
    await Promise.resolve()

    expect(reconcile).not.toHaveBeenCalled()
    unsubscribe()
  })
})
