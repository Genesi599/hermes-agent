import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { $sessionsChangeTick } from '@/store/live-sync'
import { setActiveSessionId } from '@/store/session'
import {
  $attentionSessionIds,
  $sessionStates,
  $stalledSessionIds,
  $workingSessionIds,
  clearAllSessionStates,
  publishSessionState,
  SESSION_WATCHDOG_TIMEOUT_MS
} from '@/store/session-states'

import { rehydrateLiveSessionStatuses, resetLiveRuntimeTracking } from './use-background-sync'

describe('rehydrateLiveSessionStatuses', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    setActiveSessionId(null)
    clearAllSessionStates()
    resetLiveRuntimeTracking()
  })

  it('restores running sessions after reconnect without opening them', () => {
    const now = 1_800_000_000_000

    rehydrateLiveSessionStatuses(
      {
        sessions: [
          {
            id: 'runtime-overnight',
            last_active: (now - SESSION_WATCHDOG_TIMEOUT_MS - 1_000) / 1000,
            session_key: 'overnight-exam-learning',
            status: 'working'
          },
          {
            id: 'runtime-cleanup',
            last_active: now / 1000,
            session_key: 'temporary-file-cleanup',
            status: 'working'
          }
        ]
      },
      now
    )

    expect($workingSessionIds.get()).toEqual(['overnight-exam-learning', 'temporary-file-cleanup'])
    expect($stalledSessionIds.get()).toEqual(['overnight-exam-learning'])
    expect($attentionSessionIds.get()).toEqual([])
  })

  it('restores a waiting turn as working and needing attention', () => {
    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-needs-user', session_key: 'needs-user', status: 'waiting' }]
    })

    expect($workingSessionIds.get()).toEqual(['needs-user'])
    expect($attentionSessionIds.get()).toEqual(['needs-user'])
    expect($stalledSessionIds.get()).toEqual([])
  })

  it('ignores idle, starting, and malformed live-session rows', () => {
    rehydrateLiveSessionStatuses({
      sessions: [
        { id: 'runtime-idle', session_key: 'idle-session', status: 'idle' },
        { id: 'runtime-starting', session_key: 'starting-session', status: 'starting' },
        { id: 'runtime-malformed', status: 'working' }
      ]
    })

    expect($workingSessionIds.get()).toEqual([])
    expect($attentionSessionIds.get()).toEqual([])
    expect($stalledSessionIds.get()).toEqual([])
  })

  it('settles a pending runtime when the live snapshot turns idle', () => {
    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-finished', session_key: 'finished-session', status: 'working' }]
    })

    const state = $sessionStates.get()['runtime-finished']
    expect(state?.busy).toBe(true)

    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-finished', session_key: 'finished-session', status: 'idle' }]
    })

    // A settled state no surface references is evicted from the store
    // (publishSessionState) — the settle IS the disappearance. Only the
    // absence (not a lingering busy mirror) proves the transition landed.
    expect($sessionStates.get()['runtime-finished']).toBeUndefined()
    expect($workingSessionIds.get()).toEqual([])
  })

  it('settles an orphaned busy mirror after the backend restarted under a new runtime id', () => {
    const now = 1_800_000_000_000

    // Pre-restart snapshot: the old runtime id is live and working.
    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'runtime-old', session_key: 'stored-a', status: 'working' }] },
      now - 10 * 60_000
    )

    // Backend restart: the old id vanishes (settled and evicted by the
    // vanish-reap), then the user resubmits through the stale mapping and the
    // old mirror goes busy again — while the same stored session actually runs
    // and ends under a fresh runtime id. The orphan IS the open conversation,
    // so its state must survive the settle (only unreferenced states are
    // evicted).
    rehydrateLiveSessionStatuses({ sessions: [] }, now - 5 * 60_000)
    setActiveSessionId('runtime-old')
    publishSessionState('runtime-old', {
      ...createClientSessionState('stored-a'),
      awaitingResponse: true,
      busy: true,
      turnStartedAt: now - 120_000
    })

    const tickBefore = $sessionsChangeTick.get()

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'runtime-new', session_key: 'stored-a', status: 'idle' }] },
      now
    )

    const settled = $sessionStates.get()['runtime-old']
    expect(settled?.busy).toBe(false)
    expect(settled?.awaitingResponse).toBe(false)
    expect(settled?.turnStartedAt).toBeNull()
    // The transcript re-pull must be triggered immediately, not on the next
    // poll slot — busyRef blocks the 2s transcript refresh until this settle.
    expect($sessionsChangeTick.get()).toBeGreaterThan(tickBefore)
  })

  it('keeps a just-submitted orphan inside the register grace window', () => {
    const now = 1_800_000_000_000

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'runtime-grace', session_key: 'stored-b', status: 'working' }] },
      now - 60_000
    )
    rehydrateLiveSessionStatuses({ sessions: [] }, now - 30_000)
    setActiveSessionId('runtime-grace')
    publishSessionState('runtime-grace', {
      ...createClientSessionState('stored-b'),
      awaitingResponse: true,
      busy: true,
      turnStartedAt: now - 5_000
    })

    rehydrateLiveSessionStatuses({ sessions: [] }, now)

    expect($sessionStates.get()['runtime-grace']?.busy).toBe(true)
  })

  it('does not sweep another profile mirror through this profile snapshot', () => {
    const now = 1_800_000_000_000

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'runtime-other-profile', session_key: 'stored-c', status: 'working' }] },
      now,
      'profile-other'
    )
    rehydrateLiveSessionStatuses({ sessions: [] }, now, 'default')

    expect($sessionStates.get()['runtime-other-profile']?.busy).toBe(true)
  })
})
