import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionActionsMenu } from './session-actions-menu'

afterEach(cleanup)

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

  it('starts a parent recall immediately and shows the child count', async () => {
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
    fireEvent.click(await screen.findByText('Recall 3 child conversations'))

    await waitFor(() => expect(onMergeChildren).toHaveBeenCalledOnce())
  })

  it('opens batch branch creation from the active parent menu', async () => {
    const onCreateBranches = vi.fn()

    render(
      <SessionActionsMenu onCreateBranches={onCreateBranches} sessionId="parent" title="Parent">
        <button type="button">Open branch actions</button>
      </SessionActionsMenu>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open branch actions' }), { button: 0 })
    fireEvent.click(await screen.findByText('Create Conversation Branches'))

    expect(onCreateBranches).toHaveBeenCalledOnce()
  })
})
