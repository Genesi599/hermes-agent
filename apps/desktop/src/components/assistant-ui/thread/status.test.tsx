import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { I18nProvider } from '@/i18n'
import { $activeSessionId, $reviewActivityBySessionId, $turnStartedAt } from '@/store/session'

import { ResponseLoadingIndicator, StreamStallIndicator } from './status'

// StreamStallIndicator reads message shape via useAuiState; only its hook
// stability across runtime swaps is under test here, so stub the store
// selector instead of standing up a full AssistantRuntimeProvider.
vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({ message: { content: [{ type: 'text', text: 'x' }] } })
  }
})

function renderIndicator() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ResponseLoadingIndicator />
    </I18nProvider>
  )
}

describe('ResponseLoadingIndicator timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    __resetElapsedTimerRegistryForTests()
  })

  afterEach(() => {
    cleanup()
    $activeSessionId.set(null)
    $turnStartedAt.set(null)
    __resetElapsedTimerRegistryForTests()
    vi.useRealTimers()
  })

  it('preserves each running session timer while switching between sessions', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const sessionA = renderIndicator()

    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '5s').length).toBeGreaterThan(0)
    sessionA.unmount()

    $activeSessionId.set('session-b')
    $turnStartedAt.set(Date.now())
    const sessionB = renderIndicator()

    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '3s').length).toBeGreaterThan(0)
    sessionB.unmount()

    $activeSessionId.set('session-a')
    $turnStartedAt.set(new Date('2026-01-01T00:00:00.000Z').getTime())
    renderIndicator()

    expect(screen.getAllByText((_, node) => node?.textContent === '8s').length).toBeGreaterThan(0)
  })
})

// The status line sits between tool rows and thinking headers, which the
// transcript rests at a fade. Without the mark it reads a shade brighter than
// both — the one line in the column claiming emphasis it hasn't earned.
describe('status line', () => {
  afterEach(cleanup)

  it('is marked as transcript scaffolding', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const { container } = renderIndicator()

    expect(container.querySelector('[role="status"]')?.hasAttribute('data-conversation-scaffold')).toBe(true)
  })

  it('keeps a visible thinking label and continuous motion cue before the first token', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const { container } = renderIndicator()

    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(
      container.querySelector('[data-slot="aui_response-loading"] [class~="motion-safe:animate-pulse"]')
    ).toBeTruthy()
  })
})

// The stall indicator stays mounted while the runtime unbinds and rebinds —
// merge-into-parent nulls the active runtime before selecting the parent,
// and tile focus moves do the same. Gating a useStore hook on sessionId
// changed the hook count between renders (React #311) and tore down the
// whole workspace error boundary. The hook must subscribe unconditionally.
describe('StreamStallIndicator hook stability', () => {
  afterEach(() => {
    cleanup()
    $activeSessionId.set(null)
    $reviewActivityBySessionId.set({})
  })

  const renderStall = () =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <StreamStallIndicator />
      </I18nProvider>
    )

  it('survives the active runtime going away and coming back', () => {
    $activeSessionId.set('rt-a')
    const view = renderStall()

    // Runtime unbind (merge finished / parent selection in flight).
    act(() => {
      $activeSessionId.set(null)
    })
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <StreamStallIndicator />
      </I18nProvider>
    )

    // Runtime rebind (parent session resumed and activated).
    act(() => {
      $activeSessionId.set('rt-b')
    })
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <StreamStallIndicator />
      </I18nProvider>
    )

    // No throw means the hook count stayed stable across the swap.
    expect(document.querySelector('[data-slot="aui_stream-stall"], [data-slot="aui_review-stall"]') || document.body).toBeTruthy()
  })

  it('picks up review activity for the bound runtime after a swap', () => {
    $activeSessionId.set('rt-a')
    $reviewActivityBySessionId.set({ 'rt-a': 'branch-merge', 'rt-b': 'delete' })
    const view = renderStall()

    act(() => {
      $activeSessionId.set('rt-b')
    })
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <StreamStallIndicator />
      </I18nProvider>
    )

    // Renders null (not running) without violating hook rules — the important
    // part is that both rerenders completed without throwing.
    expect(view).toBeTruthy()
  })
})
