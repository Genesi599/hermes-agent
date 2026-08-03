import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setSessions } from '@/store/session'

import { SessionActionsMenu } from './session-actions-menu'

const mocks = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue({}) }))

vi.mock('@/store/gateway', () => ({
  activeGateway: () => ({ request: mocks.request })
}))

afterEach(() => {
  cleanup()
  mocks.request.mockClear()
  setSessions([])
})

describe('SessionActionsMenu branch merge', () => {
  it('starts the merge immediately without opening a confirmation dialog', async () => {
    const onMerge = vi.fn(async () => undefined)

    render(
      <SessionActionsMenu onMerge={onMerge} sessionId="child" title="Branch #1">
        <button type="button">Open actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open actions' }), { button: 0 })
    fireEvent.click(await screen.findByText('Merge into parent'))

    await waitFor(() => expect(onMerge).toHaveBeenCalledOnce())
    expect(screen.queryByText('Merge branch into parent?')).toBeNull()
  })

  it('shows a one-click recall action with the direct child count', async () => {
    const onMergeChildren = vi.fn(async () => undefined)

    render(
      <SessionActionsMenu
        mergeChildrenCount={3}
        onMergeChildren={onMergeChildren}
        sessionId="parent"
        title="Parent"
      >
        <button type="button">Open parent actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open parent actions' }), { button: 0 })
    fireEvent.click(await screen.findByText('Recall 3 child sessions'))

    await waitFor(() => expect(onMergeChildren).toHaveBeenCalledOnce())
  })

  it('does not show the recall action when the parent has no children', async () => {
    render(
      <SessionActionsMenu sessionId="parent" title="Parent">
        <button type="button">Open parent actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open parent actions' }), { button: 0 })

    expect(screen.queryByText(/Recall .* child session/)).toBeNull()
  })

  it('sends one parent-scoped RPC for a batch pause action', async () => {
    setSessions([
      { id: 'parent', parent_session_id: null, title: 'Parent' },
      { id: 'child-1', parent_session_id: 'parent', title: 'Child 1', branch_task_status: 'running' },
      { id: 'child-2', parent_session_id: 'parent', title: 'Child 2', branch_task_status: 'queued' }
    ] as never)

    render(
      <SessionActionsMenu mergeChildrenCount={2} sessionId="parent" title="Parent">
        <button type="button">Open batch actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open batch actions' }), { button: 0 })
    const branchTasks = await screen.findByText('Branch tasks')
    fireEvent.keyDown(branchTasks.closest('[role="menuitem"]') ?? branchTasks, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByText('Pause all'))

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('session.branch_batch_control', {
        action: 'pause_all',
        parent_session_id: 'parent'
      })
    )
  })

  it('merges completed children while unfinished siblings remain', async () => {
    const onMergeCompletedChildren = vi.fn(async () => undefined)

    setSessions([
      { id: 'parent', parent_session_id: null, title: 'Parent' },
      { id: 'child-1', parent_session_id: 'parent', title: 'Child 1', branch_task_status: 'completed' },
      { id: 'child-2', parent_session_id: 'parent', title: 'Child 2', branch_task_status: 'running' }
    ] as never)

    render(
      <SessionActionsMenu
        mergeChildrenCount={2}
        onMergeCompletedChildren={onMergeCompletedChildren}
        sessionId="parent"
        title="Parent"
      >
        <button type="button">Open completed actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open completed actions' }), { button: 0 })
    const branchTasks = await screen.findByText('Branch tasks')
    fireEvent.keyDown(branchTasks.closest('[role="menuitem"]') ?? branchTasks, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByText('Merge completed (1)'))

    await waitFor(() => expect(onMergeCompletedChildren).toHaveBeenCalledOnce())
  })
})
