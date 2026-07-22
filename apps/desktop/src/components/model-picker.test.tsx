import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ModelPickerDialog } from './model-picker'

vi.mock('@/lib/model-options', () => ({
  requestModelOptions: vi.fn().mockResolvedValue({
    providers: [{ slug: 'new-provider', name: 'New provider', models: ['new/model'] }]
  })
}))

vi.mock('@/store/onboarding', () => ({
  startManualOnboarding: vi.fn()
}))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)

Element.prototype.scrollIntoView = function scrollIntoView() {}

describe('ModelPickerDialog', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lets the desktop picker target every conversation in the current profile', async () => {
    const onSelect = vi.fn()

    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ModelPickerDialog
            allowApplyAll
            currentModel="current/model"
            currentProvider="current-provider"
            onOpenChange={vi.fn()}
            onSelect={onSelect}
            open
          />
        </I18nProvider>
      </QueryClientProvider>
    )

    const current = screen.getByRole('button', { name: '当前对话' })
    const all = screen.getByRole('button', { name: '全部对话' })

    expect(current.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('只切换当前正在查看的对话。')).toBeTruthy()

    fireEvent.click(all)

    expect(all.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('切换当前配置文件中的全部对话，并设为新对话的默认模型。')).toBeTruthy()

    fireEvent.click(await screen.findByText('new/model'))

    expect(onSelect).toHaveBeenCalledWith({ model: 'new/model', provider: 'new-provider', scope: 'all' })
  })
})
