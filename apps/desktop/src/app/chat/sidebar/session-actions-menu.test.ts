import { atom, type WritableAtom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import { $focusedRuntimeId, $focusedStoredSessionId } from '@/store/session-states'

import { renameSessionPreferringRpc } from './session-actions-menu'

// Rename must translate the actually focused stored session to its runtime id.
// A branch tile can be focused while the route-selected primary remains its
// parent; using the primary runtime would rename the wrong session or return
// "Session not found".

// Hoisted so the vi.mock factories below (which vitest lifts to the top of the
// module) can reference these before the module body runs. This matters because
// projects.ts subscribes to $gateway at import and nanostores fires the
// subscriber synchronously — that reaches the @/store/gateway mock's
// activeGateway() during the transitive import on line 4, before a plain
// module-level const would be initialized (temporal dead zone).
const { renameSession, request, activeGateway } = vi.hoisted(() => ({
  renameSession: vi.fn(async () => ({ ok: true, title: 'rest-title' })),
  request: vi.fn(async () => ({ title: 'rpc-title' }) as never),
  activeGateway: vi.fn<() => { request: unknown } | null>(() => ({ request: undefined }))
}))

// Wire activeGateway's default return to the shared request mock now that it exists.
activeGateway.mockReturnValue({ request })

vi.mock('@/hermes', () => ({
  renameSession: (...args: unknown[]) => renameSession(...(args as [])),
  // profile.ts calls this at import (its $activeGatewayProfile subscribe fires
  // immediately), pulled in transitively via session-states.
  setApiRequestProfile: () => {},
  HermesGateway: class {}
}))

vi.mock('@/store/gateway', () => ({
  // projects.ts subscribes to $gateway at module load (its repo-scan sync fires
  // immediately), pulled in transitively via the session store. Provide a real
  // atom plus the hoisted activeGateway so the synchronous subscriber doesn't
  // throw on an incomplete mock or hit an uninitialized reference.
  $gateway: atom(null),
  activeGateway: () => activeGateway()
}))

vi.mock('@/store/session-states', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const { atom: createAtom } = await import('nanostores')

  return {
    ...actual,
    $focusedRuntimeId: createAtom<null | string>(null),
    $focusedStoredSessionId: createAtom<null | string>(null)
  }
})

const RUNTIME_ID = 'rt-runtime-1'
const STORED_ID = 'stored-branch-1'
const focusedRuntimeId = $focusedRuntimeId as unknown as WritableAtom<null | string>
const focusedStoredSessionId = $focusedStoredSessionId as unknown as WritableAtom<null | string>

afterEach(() => {
  renameSession.mockClear()
  request.mockClear()
  activeGateway.mockReset()
  activeGateway.mockReturnValue({ request })
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  focusedRuntimeId.set(null)
  focusedStoredSessionId.set(null)
})

describe('renameSessionPreferringRpc', () => {
  it('renames a focused branch tile through its own runtime, not the selected primary runtime', async () => {
    $selectedStoredSessionId.set('stored-parent')
    $activeSessionId.set('runtime-parent')
    focusedStoredSessionId.set(STORED_ID)
    focusedRuntimeId.set(RUNTIME_ID)

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch')

    expect(request).toHaveBeenCalledWith('session.title', { session_id: RUNTIME_ID, title: 'My branch' })
    expect(renameSession).not.toHaveBeenCalled()
    expect(result.title).toBe('rpc-title')
  })

  it('falls back to REST when the RPC fails (e.g. socket mid-reconnect)', async () => {
    focusedStoredSessionId.set(STORED_ID)
    focusedRuntimeId.set(RUNTIME_ID)
    request.mockRejectedValueOnce(new Error('not connected'))

    const result = await renameSessionPreferringRpc(STORED_ID, 'My branch', 'work')

    expect(request).toHaveBeenCalledOnce()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', 'work')
    expect(result.title).toBe('rest-title')
  })

  it('uses REST for a non-focused row (background/persisted session)', async () => {
    focusedStoredSessionId.set('some-other-focused-session')
    focusedRuntimeId.set(RUNTIME_ID)

    await renameSessionPreferringRpc(STORED_ID, 'My branch', 'work')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', 'work')
  })

  it('uses REST when clearing the title (RPC rejects empty titles)', async () => {
    focusedStoredSessionId.set(STORED_ID)
    focusedRuntimeId.set(RUNTIME_ID)

    await renameSessionPreferringRpc(STORED_ID, '')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, '', undefined)
  })

  it('uses REST when no gateway is connected', async () => {
    focusedStoredSessionId.set(STORED_ID)
    focusedRuntimeId.set(RUNTIME_ID)
    activeGateway.mockReturnValue(null)

    await renameSessionPreferringRpc(STORED_ID, 'My branch')

    expect(request).not.toHaveBeenCalled()
    expect(renameSession).toHaveBeenCalledWith(STORED_ID, 'My branch', undefined)
  })
})
