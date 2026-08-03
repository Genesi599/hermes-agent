import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { $sessions, $unreadFinishedSessionIds } from '@/store/session'
import { $sessionColorById, $sessionColorOverrides } from '@/store/session-color'

import { SidebarSessionRow } from './session-row'

const session = {
  id: 'branch-session',
  last_active: 1,
  profile: 'default',
  started_at: 1,
  title: 'Branch session'
} as SessionInfo

function renderBranchRow({ isWorking = false, reorderable = false } = {}) {
  return render(
    <SidebarSessionRow
      branchStem="└─ "
      isPinned={false}
      isSelected={false}
      isWorking={isWorking}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onPin={vi.fn()}
      onResume={vi.fn()}
      reorderable={reorderable}
      session={session}
    />
  )
}

describe('branch session status geometry', () => {
  afterEach(() => {
    cleanup()
    $sessions.set([])
    $sessionColorOverrides.set({})
    $unreadFinishedSessionIds.set([])
  })

  it('keeps the running dot visible beside the branch stem', () => {
    const { container } = renderBranchRow({ isWorking: true })
    const lead = container.querySelector('[data-branch-lead="true"]')

    expect(lead?.classList.contains('overflow-visible')).toBe(true)
    expect(lead?.querySelector('[role="status"]')?.classList.contains('size-1.5')).toBe(true)
  })

  it('keeps the unread dot visible beside the branch stem', () => {
    $unreadFinishedSessionIds.set([session.id])
    const { container } = renderBranchRow()
    const lead = container.querySelector('[data-branch-lead="true"]')

    expect(lead?.classList.contains('overflow-visible')).toBe(true)
    expect(lead?.querySelector('[role="status"]')?.classList.contains('size-1.5')).toBe(true)
  })

  it('keeps draggable branch rows from clipping their status dot', () => {
    const { container } = renderBranchRow({ isWorking: true, reorderable: true })
    const lead = container.querySelector('[data-reorder-handle]')

    expect(lead?.classList.contains('overflow-visible')).toBe(true)
  })

  it('uses the shared conversation color for parent and branch title text', () => {
    const parent = { ...session, id: 'parent-session', title: 'Parent session' }
    const child = { ...session, id: 'child-session', parent_session_id: parent.id, title: 'Child session' }
    $sessions.set([parent, child])

    const { getByText } = render(
      <>
        <SidebarSessionRow
          isPinned={false}
          isSelected={false}
          isWorking={false}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
          onPin={vi.fn()}
          onResume={vi.fn()}
          session={parent}
        />
        <SidebarSessionRow
          branchStem="└─ "
          isPinned={false}
          isSelected={false}
          isWorking={false}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
          onPin={vi.fn()}
          onResume={vi.fn()}
          session={child}
        />
      </>
    )

    const color = $sessionColorById.get()[parent.id]
    const expectedCssColor = window.document.createElement('span')
    expectedCssColor.style.color = color

    expect($sessionColorById.get()[child.id]).toBe(color)
    expect(getByText(parent.title!).style.color).toBe(expectedCssColor.style.color)
    expect(getByText(child.title!).style.color).toBe(expectedCssColor.style.color)
  })

  it.each(['queued', 'starting', 'running', 'completed', 'failed', 'cancelled'] as const)(
    'renders durable batch status %s',
    status => {
      const { container: statusContainer } = render(
        <SidebarSessionRow
          branchStem="└─ "
          isPinned={false}
          isSelected={false}
          isWorking={status === 'running'}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
          onPin={vi.fn()}
          onResume={vi.fn()}
          session={{ ...session, branch_task_status: status, branch_started_at: 1 }}
        />
      )

      expect(statusContainer.querySelector(`[data-branch-task-status="${status}"]`)).toBeTruthy()
    }
  )
})
