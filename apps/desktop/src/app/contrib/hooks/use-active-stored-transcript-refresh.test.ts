import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { createClientSessionState } from '@/lib/chat-runtime'
import { setSessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

import type * as SessionActionsUtils from '../../session/hooks/use-session-actions/utils'
import type { ClientSessionState } from '../../types'

import { useActiveStoredTranscriptRefresh } from './use-active-stored-transcript-refresh'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: '' }))
}))

vi.mock('../../session/hooks/use-session-actions/utils', async importActual => ({
  ...(await importActual<typeof SessionActionsUtils>()),
  resolveSessionProfile: vi.fn(async () => undefined)
}))

const { getLatestSessionMessages } = await import('@/hermes')
const { resolveSessionProfile } = await import('../../session/hooks/use-session-actions/utils')

const row = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    ended_at: null,
    id: 'live',
    input_tokens: 0,
    is_active: false,
    last_active: 0,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    profile: 'default',
    source: null,
    started_at: 0,
    title: null,
    ...over
  }) as SessionInfo

const msg = (role: 'assistant' | 'user', content: string): SessionMessage =>
  ({ content, role, timestamp: 1 }) as SessionMessage

function renderRefresh() {
  let state = { messages: [] } as unknown as ClientSessionState
  const applied: ClientSessionState[] = []

  const updateSessionState = vi.fn(
    (_runtimeId: string, updater: (current: ClientSessionState) => ClientSessionState) => {
      state = updater(state)
      applied.push(state)

      return state
    }
  )

  const refs = {
    activeSessionIdRef: { current: 'runtime-1' },
    busyRef: { current: false },
    selectedStoredSessionIdRef: { current: 'stored-x' }
  }

  const { result } = renderHook(() => useActiveStoredTranscriptRefresh({ ...refs, updateSessionState }))

  return { applied, refs, refresh: result.current, updateSessionState }
}

describe('useActiveStoredTranscriptRefresh', () => {
  beforeEach(() => {
    setSessions([])
    $sessionStates.set({})
    vi.mocked(getLatestSessionMessages).mockReset()
    vi.mocked(getLatestSessionMessages).mockResolvedValue({ messages: [], session_id: '' })
    vi.mocked(resolveSessionProfile).mockReset()
    vi.mocked(resolveSessionProfile).mockResolvedValue(undefined)
  })

  afterEach(() => {
    setSessions([])
    $sessionStates.set({})
  })

  it('refreshes an off-list agent conversation by resolving its profile', async () => {
    // The bug this pins: a conversation opened from an agent chip is NOT in
    // the profile-scoped sidebar list, so the old `if (!stored) return` gate
    // froze its transcript at the open-time snapshot forever. The refresh must
    // resolve the owning profile cross-profile and still pull the transcript.
    vi.mocked(resolveSessionProfile).mockResolvedValue('steward')
    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', 'hi'), msg('assistant', 'OK')],
      session_id: 'stored-x'
    })

    const { applied, refresh, updateSessionState } = renderRefresh()

    await refresh()

    expect(resolveSessionProfile).toHaveBeenCalledWith('stored-x')
    expect(getLatestSessionMessages).toHaveBeenCalledWith('stored-x', 'steward')
    expect(updateSessionState).toHaveBeenCalledTimes(1)
    expect(applied[0].messages).toHaveLength(2)
  })

  it('memoizes the resolved profile and skips redundant updateSessionState on unchanged signature', async () => {
    vi.mocked(resolveSessionProfile).mockResolvedValue('steward')
    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', 'hi')],
      session_id: 'stored-x'
    })

    const { refresh, updateSessionState } = renderRefresh()

    await refresh()
    await refresh()

    // The poll DID fetch again, but the identical signature must gate the
    // second state write (no churn on a no-change poll).
    expect(getLatestSessionMessages).toHaveBeenCalledTimes(2)
    expect(resolveSessionProfile).toHaveBeenCalledTimes(1)
    expect(updateSessionState).toHaveBeenCalledTimes(1)
  })

  it('updates again once the transcript signature changes', async () => {
    vi.mocked(resolveSessionProfile).mockResolvedValue('steward')
    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', 'hi')],
      session_id: 'stored-x'
    })

    const { refresh, updateSessionState } = renderRefresh()

    await refresh()

    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', 'hi'), msg('assistant', 'new turn')],
      session_id: 'stored-x'
    })

    await refresh()

    expect(updateSessionState).toHaveBeenCalledTimes(2)
  })

  it('quietly skips when no profile library owns the id', async () => {
    vi.mocked(resolveSessionProfile).mockResolvedValue(undefined)

    const { refresh, updateSessionState } = renderRefresh()

    await expect(refresh()).resolves.toBeUndefined()
    expect(getLatestSessionMessages).not.toHaveBeenCalled()
    expect(updateSessionState).not.toHaveBeenCalled()
  })

  it('keeps the sidebar-row fast path (no cross-profile resolve)', async () => {
    setSessions([row({ id: 'stored-x', profile: 'default' })])
    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', 'hi')],
      session_id: 'stored-x'
    })

    const { applied, refresh, updateSessionState } = renderRefresh()

    await refresh()

    expect(resolveSessionProfile).not.toHaveBeenCalled()
    expect(getLatestSessionMessages).toHaveBeenCalledWith('stored-x', 'default')
    expect(updateSessionState).toHaveBeenCalledTimes(1)
    expect(applied[0].messages).toHaveLength(1)
  })

  it('still refuses to refresh while a turn is running', async () => {
    const { refresh, refs, updateSessionState } = renderRefresh()

    refs.busyRef.current = true
    await refresh()

    expect(getLatestSessionMessages).not.toHaveBeenCalled()
    expect(updateSessionState).not.toHaveBeenCalled()
  })

  it('refreshes an adopted running turn despite busy', async () => {
    // The chip-opened conversation of an agent turn: the resume reported the
    // session running, busyRef is true, but the turn was submitted through
    // REST by the dispatcher — its events stream to the transport pinned at
    // turn start and never reach this window. With no local stream to
    // protect, the durable pull is the only thing that can move the
    // transcript while the turn runs; gating on busy froze it at the
    // open-time snapshot for the whole turn ("can't see it thinking").
    $sessionStates.set({
      'runtime-1': { ...createClientSessionState(null), busy: true, adoptedRunningTurn: true }
    })
    setSessions([row({ id: 'stored-x', profile: 'default' })])
    vi.mocked(getLatestSessionMessages).mockResolvedValue({
      messages: [msg('user', '派活'), msg('assistant', '正在查')],
      session_id: 'stored-x'
    })

    const { applied, refs, refresh, updateSessionState } = renderRefresh()

    refs.busyRef.current = true
    await refresh()

    expect(getLatestSessionMessages).toHaveBeenCalledTimes(1)
    expect(updateSessionState).toHaveBeenCalledTimes(1)
    expect(applied[0].messages).toHaveLength(2)
  })

  it('keeps the busy gate for a turn this window started', async () => {
    // busy with adoptedRunningTurn false = the local websocket stream owns
    // the transcript; a fetch-and-replace would fight it. Must stay off.
    $sessionStates.set({
      'runtime-1': { ...createClientSessionState(null), busy: true, adoptedRunningTurn: false }
    })
    const { refs, refresh, updateSessionState } = renderRefresh()

    refs.busyRef.current = true
    await refresh()

    expect(getLatestSessionMessages).not.toHaveBeenCalled()
    expect(updateSessionState).not.toHaveBeenCalled()
  })
})
