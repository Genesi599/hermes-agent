import { useEffect } from 'react'

import { getLatestSessionMessages, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import { toChatMessages } from '@/lib/chat-messages'
import { publishSessionState, setSessionTileDelegate } from '@/store/session-states'
import { ensureGatewayProfile } from '@/store/profile'
import type { SessionResumeResponse } from '@/types/hermes'

import type { usePromptActions } from '../../session/hooks/use-prompt-actions'
import { withSessionNotFoundResume } from '../../session/hooks/use-prompt-actions/utils'
import { resolveSessionProfile } from '../../session/hooks/use-session-actions/utils'
import type { useSessionStateCache } from '../../session/hooks/use-session-state-cache'
import type { GatewayRequester } from '../types'

type SessionStateCache = ReturnType<typeof useSessionStateCache>

interface SessionTileDelegateParams {
  archiveSession: (storedSessionId: string) => Promise<unknown>
  branchStoredSession: (storedSessionId: string) => Promise<unknown>
  duplicateStoredSession: (storedSessionId: string) => Promise<unknown>
  executeSlashCommand: ReturnType<typeof usePromptActions>['executeSlashCommand']
  removeSession: (storedSessionId: string) => Promise<unknown>
  requestGateway: GatewayRequester
  runtimeIdByStoredSessionIdRef: SessionStateCache['runtimeIdByStoredSessionIdRef']
  sessionStateByRuntimeIdRef: SessionStateCache['sessionStateByRuntimeIdRef']
  updateSessionState: SessionStateCache['updateSessionState']
}

/**
 * Publishes the session-tile delegate: resume / submit / interrupt / slash for
 * tiled sessions WITHOUT touching the primary view ($activeSessionId /
 * $messages stay the main thread's). Resume reuses a live runtime binding when
 * one exists (incl. the main thread's own session); a cold tile binds +
 * hydrates the cache, which publishSessionState mirrors to the tile.
 */
export function useSessionTileDelegate({
  archiveSession,
  branchStoredSession,
  duplicateStoredSession,
  executeSlashCommand,
  removeSession,
  requestGateway,
  runtimeIdByStoredSessionIdRef,
  sessionStateByRuntimeIdRef,
  updateSessionState
}: SessionTileDelegateParams): void {
  useEffect(() => {
    // A tile's runtime binding can die the same way the foreground's does
    // (sleep/wake, backend restart). The cache maps stored -> runtime, so walk
    // it backwards to find the durable id this runtime belongs to.
    const storedSessionIdForRuntime = (runtimeId: string): null | string => {
      const cached = sessionStateByRuntimeIdRef.current.get(runtimeId)?.storedSessionId

      if (cached) {
        return cached
      }

      for (const [storedId, mapped] of runtimeIdByStoredSessionIdRef.current) {
        if (mapped === runtimeId) {
          return storedId
        }
      }

      return null
    }

    // Repoint the stored -> runtime mapping at the recovered id so subsequent
    // tile actions use the live binding instead of re-recovering every call.
    const rebindTileRuntime = (deadRuntimeId: string) => (recoveredId: string) => {
      const storedId = storedSessionIdForRuntime(deadRuntimeId)

      if (storedId) {
        runtimeIdByStoredSessionIdRef.current.set(storedId, recoveredId)
      }
    }

    setSessionTileDelegate({
      archiveSession: async storedSessionId => {
        await archiveSession(storedSessionId)
      },
      branchSession: async storedSessionId => {
        await branchStoredSession(storedSessionId)
      },
      duplicateSession: async storedSessionId => {
        await duplicateStoredSession(storedSessionId)
      },
      deleteSession: async storedSessionId => {
        await removeSession(storedSessionId)
      },
      executeSlash: async (rawCommand, sessionId) => {
        await executeSlashCommand(rawCommand, { sessionId })
      },
      interruptSession: async runtimeId => {
        await withSessionNotFoundResume(
          runtimeId,
          storedSessionIdForRuntime(runtimeId),
          liveId => requestGateway('session.interrupt', { session_id: liveId }),
          { requestGateway, onRecovered: rebindTileRuntime(runtimeId) }
        )
      },
      resumeTile: async storedSessionId => {
        const existing = runtimeIdByStoredSessionIdRef.current.get(storedSessionId)
        const cached = existing ? sessionStateByRuntimeIdRef.current.get(existing) : undefined

        if (existing && cached?.storedSessionId === storedSessionId) {
          publishSessionState(existing, cached)

          return existing
        }

        // Resolve the owning profile before binding a runtime. A tile can open a
        // session from any profile, not just the active one; resuming (or
        // reading messages) without a profile lets the gateway fall back to the
        // launch-profile DB and fork the conversation into the wrong profile —
        // the same cross-profile bleed the recovery resumes had (#67603).
        const profile = await resolveSessionProfile(storedSessionId)

        // PROFILE SWAP FIRST (2026-09-30): the tile path used to fire the
        // resume straight at the CURRENT gateway with only a `profile` param,
        // betting on backend-side scoping. When the active gateway stayed on
        // another profile the bet lost silently (绘图师 tile: resume lost,
        // route-resume tug-of-war, "一直加载"). Swap the gateway BEFORE the
        // RPC, exactly like the main resume path (use-session-actions).
        if (profile) {
          await ensureGatewayProfile(profile)
        }

        const [prefetch, resumed] = await Promise.all([
          getLatestSessionMessages(storedSessionId, profile).catch(() => null),
          // TIMEOUT + OMIT RETRY (2026-09-30): a huge transcript whose WS
          // copy never completes hangs this Promise.all forever (the 4.6MB
          // 绘图师 lineage). Race the RPC against a cap and retry once with
          // omit_messages — the prefetch side of this same Promise.all is the
          // transcript source when it lands (see the messages merge below).
          Promise.race([
            (async () => {
              const first = await requestGateway<SessionResumeResponse>('session.resume', {
              session_id: storedSessionId,
              cols: 96,
            // NO omit_messages (2026-09-23): the RPC is the FALLBACK message
            // source. With `omit_messages: true` the resume returned
            // `messages: []` and the whole transcript came from the REST
            // prefetch — so any prefetch miss (IPC hiccup, big session,
            // cross-profile route) left the tile permanently BLANK with no
            // spinner and no error ("打开了但一直加载", reported on 绘图师 /
            // Hermes 工程师). The main path made the same bet. Let the RPC
            // carry the messages too; a prefetch that succeeds still wins
            // below (state.messages.length > 0 branch), so the payload cost
            // only shows up on the miss it is there to rescue.
                ...(profile ? { profile } : {})
              }).catch(() => null)

              return first ?? requestGateway<SessionResumeResponse>('session.resume', {
                session_id: storedSessionId,
                cols: 96,
                omit_messages: true,
                ...(profile ? { profile } : {})
              })
            })(),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('tile resume timed out')), 12_000)
            })
          ])
        ])

        const runtimeId = resumed?.session_id

        if (!runtimeId) {
          throw new Error('resume returned no session id')
        }

        updateSessionState(
          runtimeId,
          state => ({
            ...state,
            busy: Boolean(resumed?.info?.running),
            messages:
              state.messages.length > 0 ? state.messages : toChatMessages(prefetch?.messages ?? resumed?.messages ?? [])
          }),
          storedSessionId
        )

        return runtimeId
      },
      submitToSession: async (runtimeId, text) => {
        await withSessionNotFoundResume(
          runtimeId,
          storedSessionIdForRuntime(runtimeId),
          liveId => requestGateway('prompt.submit', { session_id: liveId, text }, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS),
          { requestGateway, onRecovered: rebindTileRuntime(runtimeId) }
        )
      },
      updateSession: (runtimeId, updater) => updateSessionState(runtimeId, updater)
    })
  }, [
    archiveSession,
    branchStoredSession,
    executeSlashCommand,
    removeSession,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    updateSessionState
  ])
}
