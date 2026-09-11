import { afterEach, describe, expect, it, vi } from 'vitest'

import { group } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree } from '@/components/pane-shell/tree/store'
import type * as HermesApi from '@/hermes'
import { listAllProfileSessions } from '@/hermes'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $selectedStoredSessionId, $unreadFinishedSessionIds, setSessions } from '@/store/session'
import { $sessionStates, publishSessionState } from '@/store/session-states'

import {
  canonicalUnreadSessionIds,
  reconcileTaskbarUnreadSessions,
  subscribeFocusedSessionRead,
  subscribeSelectedSessionRead,
  subscribeTaskbarUnreadBadge,
  subscribeUnreadSessionReconciliation,
  subscribeWorkingSessionsRead
} from './use-taskbar-unread-badge'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  listAllProfileSessions: vi.fn()
}))

describe('subscribeTaskbarUnreadBadge', () => {
  afterEach(() => {
    vi.useRealTimers()
    $unreadFinishedSessionIds.set([])
    $selectedStoredSessionId.set(null)
    $activeTreeGroup.set(null)
    $layoutTree.set(null)
    setSessions([])
    $sessionStates.set({})
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
      canonicalUnreadSessionIds(
        ['working', 'idle'],
        [
          { id: 'working', last_active: 20, started_at: 10, status: 'working' },
          { id: 'idle', last_active: 10, started_at: 10, status: 'idle' }
        ],
        new Set(['working'])
      )
    ).toEqual(['idle'])
  })

  it('keeps a just-finished session unread when only the STALE snapshot says working', () => {
    // Green-dot regression: the list's status lags the turn end by a refresh
    // cycle while the live set already knows it finished — the unread (and
    // its dot) must survive that lag instead of being demoted to stale.
    expect(
      canonicalUnreadSessionIds(
        ['just-finished'],
        [{ id: 'just-finished', last_active: 20, started_at: 10, status: 'working' }],
        new Set()
      )
    ).toEqual(['just-finished'])
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

  it('marks the actually focused session tab as read', () => {
    $unreadFinishedSessionIds.set(['primary', 'focused'])
    $selectedStoredSessionId.set('primary')
    $layoutTree.set(group(['session-tile:focused'], { active: 'session-tile:focused', id: 'chat-group' }))
    $activeTreeGroup.set('chat-group')

    const unsubscribe = subscribeFocusedSessionRead()

    expect($unreadFinishedSessionIds.get()).toEqual(['primary'])
    unsubscribe()
  })

  it('clears unread aliases when a loaded session starts working again', () => {
    $unreadFinishedSessionIds.set(['root', 'tip', 'idle'])
    setSessions([
      { id: 'tip', _lineage_root_id: 'root', status: 'idle' } as never,
      { id: 'idle', status: 'idle' } as never
    ])
    const unsubscribe = subscribeWorkingSessionsRead()

    // The live event flips busy first; the list row then catches up.
    publishSessionState('rt-working', { ...createClientSessionState('tip'), busy: true })
    setSessions([
      { id: 'tip', _lineage_root_id: 'root', status: 'working' } as never,
      { id: 'idle', status: 'idle' } as never
    ])

    expect($unreadFinishedSessionIds.get()).toEqual(['idle'])
    unsubscribe()
  })

  it('does NOT wipe unread when only the stale snapshot says working (green-dot regression)', () => {
    $unreadFinishedSessionIds.set(['tip'])
    const unsubscribe = subscribeWorkingSessionsRead()

    // Snapshot lag: the list still says working, but the live set knows the
    // turn ended (empty). The just-finished unread must survive the refresh.
    setSessions([{ id: 'tip', status: 'working' } as never])

    expect($unreadFinishedSessionIds.get()).toEqual(['tip'])
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
