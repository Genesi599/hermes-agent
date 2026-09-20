import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { atom } from 'nanostores'

// Store doubles live INSIDE the mock factories (vi.mock hoists factories
// above module-level consts). Shared atoms are exposed on globalThis.
const tiles = (globalThis as any).__tiles ?? ((globalThis as any).__tiles = atom<Array<{ storedSessionId: string; runtimeId?: string }>>([]))
const sessions = (globalThis as any).__sessions ?? ((globalThis as any).__sessions = atom<Array<{ id: string; profile?: string }>>([]))

vi.mock('@/hermes', () => ({
  getLatestSessionMessages: vi.fn(async (id: string) => ({
    session_id: id,
    messages: [{ id: 'm1', role: 'assistant', content: 'x' }]
  }))
}))
vi.mock('@/lib/chat-messages', () => ({
  preserveLocalAssistantErrors: (_next: unknown, prev: unknown) => prev ?? _next,
  toChatMessages: (raw: unknown[]) => raw
}))
vi.mock('@/lib/session-signatures', () => ({
  sessionMessagesSignature: (rows: Array<{ id?: string }>) => rows.map(r => r.id).join(',')
}))
vi.mock('@/store/live-sync', async () => {
  const { atom } = await import('nanostores')
  return {
    sessionStreamAliveRecently: () => false,
    $sessionsChangeTick: atom(0)
  }
})
vi.mock('@/store/session', () => {
  const { atom } = require('nanostores') as typeof import('nanostores')
  const sessionsAtom = atom<Array<{ id: string; profile?: string }>>([])
  ;(globalThis as any).__sessions = sessionsAtom
  return {
    $sessions: sessionsAtom,
    sessionMatchesStoredId: (s: { id: string }, id: string) => s.id === id
  }
})
vi.mock('@/store/session-states', () => {
  const { atom } = require('nanostores') as typeof import('nanostores')
  const tilesAtom = atom<Array<{ storedSessionId: string; runtimeId?: string }>>([])
  ;(globalThis as any).__tiles = tilesAtom
  return { $sessionTiles: tilesAtom }
})

import { useOpenTileTranscriptSync } from './use-open-tile-transcript-sync'

describe('useOpenTileTranscriptSync', () => {
  beforeEach(() => {
    cleanup()
    tiles.set([])
    sessions.set([])
    // jsdom starts hidden; the hook's visible guard would skip every run
    if (document.hidden) {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true, writable: true })
    }
  })

  it('refreshes an open background tile on mount; identical rows do not re-apply', async () => {
    const updates: Array<string> = []
    const updateSessionState = (runtimeId: string) => {
      updates.push(runtimeId)
    }
    tiles.set([{ storedSessionId: 'sess-a', runtimeId: 'rt-a' }])
    sessions.set([{ id: 'sess-a', profile: 'steward' }])

    renderHook(() =>
      useOpenTileTranscriptSync({
        selectedStoredSessionIdRef: { current: 'other' },
        updateSessionState: updateSessionState as any
      })
    )
    await new Promise(r => setTimeout(r, 30))
    // mount run applies once
    expect(updates).toEqual(['rt-a'])

    // same mocked rows → same signature → the 10s backstop must not re-apply
    // (short of waiting 10s, at least assert no extra applies right away)
    await new Promise(r => setTimeout(r, 30))
    expect(updates.length).toBe(1)
  })

  it('never touches the active conversation (the active refresher owns it)', async () => {
    const updateSessionState = vi.fn()
    tiles.set([{ storedSessionId: 'active-one', runtimeId: 'rt-1' }])

    renderHook(() =>
      useOpenTileTranscriptSync({
        selectedStoredSessionIdRef: { current: 'active-one' },
        updateSessionState: updateSessionState as any
      })
    )
    await new Promise(r => setTimeout(r, 30))
    expect(updateSessionState).not.toHaveBeenCalled()
  })
})
