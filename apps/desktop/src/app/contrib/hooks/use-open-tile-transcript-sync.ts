import { useEffect, useRef } from 'react'

import { getLatestSessionMessages } from '@/hermes'
import { preserveLocalAssistantErrors, toChatMessages } from '@/lib/chat-messages'
import { sessionMessagesSignature } from '@/lib/session-signatures'
import { $sessionsChangeTick, sessionStreamAliveRecently } from '@/store/live-sync'
import { $sessions, sessionMatchesStoredId } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

/**
 * UNIFIED SYNC, BACKGROUND HALF (2026-09-20): the active transcript has its
 * own refresher (use-active-stored-transcript-refresh), but an OPEN tile the
 * user is not currently looking at had NO refresh path at all — a turn run
 * by cron/dispatch finished into the DB and the tile stayed on its open-time
 * snapshot until the user clicked it away and back (the "9:00 turn not in
 * the steward chat" report).
 *
 * Same principles as the active half, calmer cadence:
 *  - signature-gated full pull (identical rows keep the previous identity —
 *    zero re-render), every tile per pass, low frequency;
 *  - a LOCAL stream (deltas arriving) is the live view — never clobbered;
 *  - driven by the same $sessionsChangeTick the rest of the app uses, plus
 *    a slow visible backstop.
 */

const TILE_SYNC_BACKSTOP_MS = 10_000

export function useOpenTileTranscriptSync({
  selectedStoredSessionIdRef,
  updateSessionState
}: {
  selectedStoredSessionIdRef: { current: null | string }
  updateSessionState: (
    runtimeId: string,
    updater: (state: any) => any,
    storedSessionId?: string
  ) => void
}): void {
  const signatureRef = useRef(new Map<string, string>())

  useEffect(() => {
    let disposed = false
    let timer: null | number = null

    const run = async () => {
      if (disposed || document.hidden) {
        return
      }

      const activeStored = selectedStoredSessionIdRef.current
      const sessions = $sessions.get()

      for (const tile of $sessionTiles.get()) {
        if (disposed) {
          return
        }

        const stored = tile.storedSessionId
        const runtimeId = tile.runtimeId

        // The ACTIVE conversation is the active refresher's beat — never
        // double-drive it here.
        if (!stored || !runtimeId || stored === activeStored) {
          continue
        }

        // A local stream IS the live view for this tile; a pull would only
        // race it with not-yet-flushed DB rows.
        if (sessionStreamAliveRecently(stored)) {
          continue
        }

        const row = sessions.find(s => sessionMatchesStoredId(s, stored))
        const profile = row?.profile ?? null

        try {
          const latest = await getLatestSessionMessages(stored, profile)
          const sig = sessionMessagesSignature(latest.messages)

          if (signatureRef.current.get(stored) === sig) {
            continue
          }

          signatureRef.current.set(stored, sig)
          const messages = toChatMessages(latest.messages)

          updateSessionState(
            runtimeId,
            (state: any) => ({ ...state, messages: preserveLocalAssistantErrors(messages, state.messages) }),
            stored
          )
        } catch {
          // Routing failed (backend re-homed mid-pass) — drop the memo so the
          // next pass re-resolves instead of caching the failure.
          signatureRef.current.delete(stored)
        }
      }
    }

    const offTick = $sessionsChangeTick.listen(() => {
      void run()
    })
    timer = window.setInterval(() => void run(), TILE_SYNC_BACKSTOP_MS)
    void run()

    return () => {
      disposed = true
      offTick()
      if (timer !== null) {
        window.clearInterval(timer)
      }
    }
  }, [selectedStoredSessionIdRef, updateSessionState])
}
