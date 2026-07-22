import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { $unreadFinishedSessionIds } from '@/store/session'

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
})
