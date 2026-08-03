import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationBranchDialog } from './conversation-branch-dialog'

const mocks = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({ batch_id: 'batch', created_count: 2, queued_count: 2 })
}))

vi.mock('@/store/gateway', () => ({
  activeGateway: () => ({ request: mocks.request })
}))

describe('ConversationBranchDialog', () => {
  afterEach(() => {
    cleanup()
    mocks.request.mockClear()
  })

  it('previews and submits multiple sibling tasks with one max-parallel value', async () => {
    render(
      <ConversationBranchDialog
        onOpenChange={vi.fn()}
        open
        parentSessionId="stored-parent"
        runtimeSessionId="runtime-parent"
      />
    )

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'RPE-01' } })
    fireEvent.change(screen.getByLabelText('Initial prompt'), { target: { value: 'task one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))

    const titles = screen.getAllByLabelText('Title')
    const prompts = screen.getAllByLabelText('Initial prompt')
    fireEvent.change(titles[1], { target: { value: 'RPE-02' } })
    fireEvent.change(prompts[1], { target: { value: 'task two' } })
    fireEvent.change(screen.getByLabelText('Maximum parallel tasks'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(screen.getByText('RPE-01')).toBeTruthy()
    expect(screen.getByText('RPE-02')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create branches' }))

    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(mocks.request).toHaveBeenCalledWith(
      'session.branch_batch',
      expect.objectContaining({
        max_parallel: 2,
        parent_session_id: 'stored-parent',
        runtime_session_id: 'runtime-parent',
        branches: [
          expect.objectContaining({ title: 'RPE-01', initial_prompt: 'task one' }),
          expect.objectContaining({ title: 'RPE-02', initial_prompt: 'task two' })
        ]
      })
    )
  })
})
