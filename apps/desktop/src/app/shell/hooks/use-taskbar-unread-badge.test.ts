import { afterEach, describe, expect, it, vi } from 'vitest'

import { listAllProfileSessions } from '@/hermes'
import { $selectedStoredSessionId, $unreadFinishedSessionIds, setSessions } from '@/store/session'

import {
  canonicalUnreadSessionIds,
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
    vi.useRealTimers()
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

    expect(listAllProfileSessions).toHaveBeenCalledWith(500, 0, 'include', 'recent', 'all')
    expect($unreadFinishedSessionIds.get()).toEqual(['live'])
  })

  it('counts one unread item for duplicate compression tips', () => {
    expect(
      canonicalUnreadSessionIds(['old-tip', 'new-tip'], [
        { id: 'old-tip', _lineage_root_id: 'root', last_active: 10, started_at: 10 },
        { id: 'new-tip', _lineage_root_id: 'root', last_active: 20, started_at: 20 }
      ])
    ).toEqual(['new-tip'])
  })

  it('does not count a previous completion while the session is working again', () => {
    expect(
      canonicalUnreadSessionIds(['working', 'idle'], [
        { id: 'working', last_active: 20, started_at: 10, status: 'working' },
        { id: 'idle', last_active: 10, started_at: 10, status: 'idle' }
      ])
    ).toEqual(['idle'])
  })

  it('migrates a lineage-root unread alias to the current tip', () => {
    expect(
      canonicalUnreadSessionIds(['root'], [
        { id: 'current-tip', _lineage_root_id: 'root', last_active: 20, started_at: 20 }
      ])
    ).toEqual(['current-tip'])
  })

  it('rewrites persisted aliases during reconciliation', async () => {
    $unreadFinishedSessionIds.set(['old-tip', 'new-tip'])
    vi.mocked(listAllProfileSessions).mockResolvedValue({
      sessions: [
        { archived: false, id: 'old-tip', _lineage_root_id: 'root', last_active: 10, started_at: 10 },
        { archived: false, id: 'new-tip', _lineage_root_id: 'root', last_active: 20, started_at: 20 }
      ]
    } as never)

    await reconcileTaskbarUnreadSessions()

    expect($unreadFinishedSessionIds.get()).toEqual(['new-tip'])
  })

  it('preserves unread completions that arrive during reconciliation', async () => {
    $unreadFinishedSessionIds.set(['root'])
    vi.mocked(listAllProfileSessions).mockImplementation(async () => {
      $unreadFinishedSessionIds.set(['root', 'just-finished'])

      return {
        sessions: [
          { archived: false, id: 'current-tip', _lineage_root_id: 'root', last_active: 20, started_at: 20 }
        ]
      } as never
    })

    await reconcileTaskbarUnreadSessions()

    expect($unreadFinishedSessionIds.get()).toEqual(['just-finished', 'current-tip'])
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

  it('rechecks a new unread id after a deferred merge deletion settles', async () => {
    vi.useFakeTimers()
    vi.mocked(listAllProfileSessions)
      .mockResolvedValueOnce({ sessions: [{ archived: false, id: 'branch-child' }] } as never)
      .mockResolvedValueOnce({ sessions: [] } as never)
    const unsubscribe = subscribeUnreadSessionReconciliation()

    $unreadFinishedSessionIds.set(['branch-child'])
    await vi.runAllTicks()
    await vi.waitFor(() => expect(listAllProfileSessions).toHaveBeenCalledTimes(1))
    expect($unreadFinishedSessionIds.get()).toEqual(['branch-child'])

    await vi.advanceTimersByTimeAsync(2_500)
    await vi.waitFor(() => expect($unreadFinishedSessionIds.get()).toEqual([]))
    expect(listAllProfileSessions).toHaveBeenCalledTimes(2)

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
