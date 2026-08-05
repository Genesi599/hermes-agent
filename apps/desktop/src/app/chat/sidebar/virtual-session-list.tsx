import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useVirtualizer } from '@tanstack/react-virtual'
import type * as React from 'react'
import { type FC, useCallback, useRef } from 'react'

import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { type SidebarListRow } from '@/lib/session-date-groups'
import { sessionBucketLabel } from '@/lib/time'
import { cn } from '@/lib/utils'
import { sessionPinId } from '@/store/session'

import { SidebarDateDivider } from './chrome'
import { SidebarSessionRow } from './session-row'

interface SessionRowCommonProps {
  branchStem?: string
  isPinned: boolean
  isSelected: boolean
  onArchive: () => void
  onBranch?: () => void
  onCreateBranches?: () => void
  onDelete: () => void
  mergeChildrenCount?: number
  onMergeChildren?: () => Promise<void> | void
  onMergeCompletedChildren?: () => Promise<void> | void
  onMerge?: () => Promise<void> | void
  onPin: () => void
  onResume: () => void
  reorderable?: boolean
  showProfile?: boolean
}

export interface VirtualSessionListProps {
  activeSessionId: null | string
  className?: string
  /** Hover-revealed control for date dividers (the group-level "+"). */
  dividerAction?: React.ReactNode
  rows: SidebarListRow[]
  onArchiveSession: (sessionId: string) => void
  onBranchSession?: (sessionId: string, profile?: string) => void
  onCreateBranchesSession?: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onMergeChildrenSession?: (sessionId: string) => Promise<void> | void
  onMergeSession?: (sessionId: string, profile?: string) => Promise<void> | void
  onResumeSession: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  pinned: boolean
  pinnedSessionIdSet?: ReadonlySet<string>
  showProfileTags?: boolean
  sortable: boolean
}

const ROW_ESTIMATE_PX = 28
const OVERSCAN_ROWS = 12

export const VirtualSessionList: FC<VirtualSessionListProps> = ({
  activeSessionId,
  className,
  dividerAction,
  rows: listRows,
  onArchiveSession,
  onBranchSession,
  onCreateBranchesSession,
  onDeleteSession,
  onMergeChildrenSession,
  onMergeSession,
  onResumeSession,
  onTogglePin,
  pinned,
  pinnedSessionIdSet,
  showProfileTags = false,
  sortable
}) => {
  const { t } = useI18n()
  const dividerLabels = t.sidebar.dateDivider
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: listRows.length,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: index => {
      const row = listRows[index]

      return row ? (row.kind === 'divider' ? row.key : row.entry.session.id) : index
    },
    getScrollElement: () => scrollerRef.current,
    // jsdom-friendly default; the real rect takes over on first observe.
    initialRect: { height: 600, width: 240 },
    overscan: OVERSCAN_ROWS
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const paddingTop = virtualItems[0]?.start ?? 0
  const paddingBottom = Math.max(0, totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0))
  const childCountByParent = new Map<string, number>()

  for (const { session } of entries) {
    const parentId = session.parent_session_id?.trim()

    if (parentId) {
      childCountByParent.set(parentId, (childCountByParent.get(parentId) ?? 0) + 1)
    }
  }

  const rows = virtualItems.map(virtualItem => {
    const row = listRows[virtualItem.index]

    if (!row) {
      return null
    }

    // Dividers are non-sortable, self-measured rows interleaved with sessions.
    if (row.kind === 'divider') {
      return (
        <SidebarDateDivider
          action={dividerAction}
          data-index={virtualItem.index}
          key={row.key}
          label={'label' in row ? row.label : sessionBucketLabel(row.bucket, dividerLabels)}
          ref={virtualizer.measureElement}
        />
      )
    }

    const { branchStem, session } = row.entry
    const reorderable = sortable && !branchStem
    const childCount = childCountByParent.get(session.id) ?? 0

    const completedChildren = entries
      .map(item => item.session)
      .filter(child => child.parent_session_id?.trim() === session.id && child.branch_task_status === 'completed')

    const commonProps: SessionRowCommonProps = {
      branchStem,
      isPinned: pinnedSessionIdSet?.has(session.id) ?? pinned,
      isSelected: session.id === activeSessionId,
      onArchive: () => onArchiveSession(session.id),
      onBranch: onBranchSession ? () => onBranchSession(session.id, session.profile) : undefined,
      onCreateBranches:
        session.id === activeSessionId && onCreateBranchesSession
          ? () => onCreateBranchesSession(session.id)
          : undefined,
      onDelete: () => onDeleteSession(session.id),
      mergeChildrenCount: childCount,
      onMergeChildren:
        childCount > 0 && onMergeChildrenSession ? () => onMergeChildrenSession(session.id) : undefined,
      onMergeCompletedChildren:
        completedChildren.length > 0 && onMergeSession
          ? async () => {
              for (const child of completedChildren) {
                await onMergeSession(child.id, child.profile)
              }
            }
          : undefined,
      onMerge:
        session.parent_session_id && onMergeSession ? () => onMergeSession(session.id, session.profile) : undefined,
      onPin: () => onTogglePin(sessionPinId(session)),
      onResume: () => onResumeSession(session.id),
      reorderable,
      showProfile: showProfileTags
    }

    return reorderable ? (
      <VirtualSortableRow
        index={virtualItem.index}
        key={session.id}
        measureRef={virtualizer.measureElement}
        rowProps={commonProps}
        session={session}
      />
    ) : (
      <SidebarSessionRow
        {...commonProps}
        data-index={virtualItem.index}
        key={session.id}
        ref={virtualizer.measureElement}
        session={session}
      />
    )
  })

  // When sortable, the caller wraps this in a ReorderableList that owns the
  // DndContext + SortableContext (keyed on the same ids); the virtualized rows
  // just consume that context via useSortable.
  return (
    <div
      className={cn(
        'scrollbar-fade relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain',
        className
      )}
      ref={scrollerRef}
    >
      <div className="grid gap-px" style={{ paddingBottom: `${paddingBottom}px`, paddingTop: `${paddingTop}px` }}>
        {rows}
      </div>
    </div>
  )
}

interface VirtualSortableRowProps {
  index: number
  measureRef: (node: Element | null) => void
  rowProps: SessionRowCommonProps
  session: SessionInfo
}

function VirtualSortableRow({ index, measureRef, rowProps, session }: VirtualSortableRowProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id: session.id })

  // Merge dnd-kit's setNodeRef with the virtualizer's measureElement so
  // the row participates in both DnD hit-testing and TanStack height
  // measurement.
  const refMerged = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      measureRef(node)
    },
    [measureRef, setNodeRef]
  )

  return (
    <SidebarSessionRow
      {...rowProps}
      data-index={index}
      dragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      ref={refMerged}
      reorderable
      session={session}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    />
  )
}
