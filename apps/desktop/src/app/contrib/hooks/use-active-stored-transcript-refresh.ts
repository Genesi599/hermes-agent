import { type MutableRefObject, useCallback, useRef } from 'react'

import { getLatestSessionMessages, getSessionMessagesAfter, type SessionMessage } from '@/hermes'
import { preserveLocalAssistantErrors, toChatMessages } from '@/lib/chat-messages'
import { sessionMessagesSignature } from '@/lib/session-signatures'
import { $sessions, sessionMatchesStoredId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { resolveSessionProfile } from '../../session/hooks/use-session-actions/utils'
import type { useSessionStateCache } from '../../session/hooks/use-session-state-cache'

type SessionStateCache = ReturnType<typeof useSessionStateCache>

/** How often the incremental tail falls back to a full re-pull. after_id only
 *  ever sees APPENDS, so edits/deletes/compaction need this periodic sweep. */
const TRANSCRIPT_FULL_BACKSTOP_MS = 30_000

interface ActiveTranscriptRefreshParams {
  activeSessionIdRef: SessionStateCache['activeSessionIdRef']
  busyRef: MutableRefObject<boolean>
  selectedStoredSessionIdRef: SessionStateCache['selectedStoredSessionIdRef']
  updateSessionState: SessionStateCache['updateSessionState']
}

/**
 * Refresh the open messaging transcript (inbound platform turns arrive via
 * the background gateway, not the desktop websocket); external
 * Desktop-compatible clients can also write the selected stored session
 * without this renderer receiving a websocket event. Signature-gate the
 * durable-history refresh and never replace a local active stream — except a
 * stream this window never had: an adopted running turn (resumed onto a
 * session dispatched elsewhere) only ever moves through this pull.
 *
 * The sidebar row is only the cheap path to the owning profile — NOT a
 * precondition. A conversation opened from an agent chip lives outside the
 * profile-scoped recents list, so `$sessions` never carries it and the old
 * `if (!stored) return` gate froze that transcript at its open-time snapshot
 * forever. On a row miss the profile resolves through the same ladder the
 * open path used (cache → active backend → the other profiles; the active
 * backend is probed first, which is the profile the resume swapped the
 * gateway onto) and is memoized so the 2s polls don't re-probe. An id no
 * library owns — deleted while open, wiped backend — resolves to nothing
 * and quietly skips.
 */
export function useActiveStoredTranscriptRefresh({
  activeSessionIdRef,
  busyRef,
  selectedStoredSessionIdRef,
  updateSessionState
}: ActiveTranscriptRefreshParams) {
  const transcriptSignatureRef = useRef(new Map<string, string>())
  const profileCacheRef = useRef(new Map<string, string>())
  /** Per-session incremental state: the raw rows the view was last derived
   *  from plus their head id. A poll within the backstop window fetches ONLY
   *  the tail after `maxId` and re-derives; the periodic full re-pull (still
   *  signature-gated) catches edits/deletes that after_id cannot see. */
  const transcriptTailRef = useRef(new Map<string, { lastFullAt: number; maxId: number; raw: SessionMessage[] }>())

  return useCallback(async () => {
    const storedSessionId = selectedStoredSessionIdRef.current
    const runtimeSessionId = activeSessionIdRef.current

    if (!storedSessionId || !runtimeSessionId) {
      return
    }

    if (busyRef.current) {
      // Busy normally means THIS window submitted the turn and its deltas are
      // streaming in over the websocket — a fetch-and-replace here would fight
      // that live stream, so the poll stays off. One shape of busy has no local
      // stream to protect: an ADOPTED running turn (this window resumed onto a
      // session already running elsewhere — an agent-dispatch turn, submitted
      // through REST, whose events stream to the transport pinned at turn
      // start and never reach this window). For that turn this durable pull is
      // the only thing that can move the transcript; without the exception it
      // freezes at the open-time snapshot for the whole turn.
      const adopted = $sessionStates.get()[runtimeSessionId]?.adoptedRunningTurn === true

      if (!adopted) {
        return
      }
    }

    const stored = $sessions.get().find(s => sessionMatchesStoredId(s, storedSessionId))

    // Row hit keeps the previous behavior: `stored.profile` may legitimately
    // be undefined (single-profile installs don't stamp it), and the fetch
    // then runs against the live backend exactly as before.
    let profile: null | string | undefined = stored?.profile ?? profileCacheRef.current.get(storedSessionId) ?? null

    if (!stored && !profile) {
      profile = await resolveSessionProfile(storedSessionId)

      if (!profile) {
        return
      }

      profileCacheRef.current.set(storedSessionId, profile)
    }

    const signatureKey = `${profile ?? 'default'}:${storedSessionId}`

    // One cached session at a time — switching conversations must not keep
    // growing the cache, and a stale tail for a revisited session only costs
    // one full re-pull.
    for (const key of transcriptTailRef.current.keys()) {
      if (key !== signatureKey) {
        transcriptTailRef.current.delete(key)
      }
    }

    const applyDerived = (raw: SessionMessage[]) => {
      const messages = toChatMessages(raw)

      updateSessionState(
        runtimeSessionId,
        state => ({ ...state, messages: preserveLocalAssistantErrors(messages, state.messages) }),
        storedSessionId
      )
    }

    try {
      const tail = transcriptTailRef.current.get(signatureKey)

      if (tail && Date.now() - tail.lastFullAt < TRANSCRIPT_FULL_BACKSTOP_MS) {
        const grown = await getSessionMessagesAfter(storedSessionId, profile, tail.maxId)

        if (grown.messages.length === 0) {
          return
        }

        const maxId = grown.messages.reduce(
          (head, message) => Math.max(head, Number(message.id ?? message.row_id ?? 0) || 0),
          tail.maxId
        )

        tail.raw = [...tail.raw, ...grown.messages].slice(-800)
        tail.maxId = maxId
        applyDerived(tail.raw)

        return
      }

      const latest = await getLatestSessionMessages(storedSessionId, profile)
      const sig = sessionMessagesSignature(latest.messages)

      if (transcriptSignatureRef.current.get(signatureKey) === sig) {
        if (tail) {
          tail.lastFullAt = Date.now()
        }

        return
      }

      transcriptSignatureRef.current.set(signatureKey, sig)
      transcriptTailRef.current.set(signatureKey, {
        lastFullAt: Date.now(),
        maxId: latest.messages.reduce((head, message) => Math.max(head, Number(message.id ?? message.row_id ?? 0) || 0), 0),
        raw: latest.messages
      })
      applyDerived(latest.messages)
    } catch {
      // Non-fatal: next poll or manual refresh can hydrate. Drop the memoized
      // profile so a fetch that no longer routes (backend re-homed) re-resolves
      // instead of retrying a dead profile forever, and drop the tail so the
      // next poll re-pulls fully instead of appending onto a stale cache.
      profileCacheRef.current.delete(storedSessionId)
      transcriptTailRef.current.delete(signatureKey)
    }
  }, [activeSessionIdRef, busyRef, selectedStoredSessionIdRef, updateSessionState])
}
