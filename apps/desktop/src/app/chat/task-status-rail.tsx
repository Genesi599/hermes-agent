import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import type { ChatMessage } from '@/lib/chat-messages'
import type { TaskStatus } from '@/lib/task-status'
import { cn } from '@/lib/utils'
import {
  $taskStatusRailCollapsed,
  $taskStatusRailEnabled,
  toggleTaskStatusRail,
  toggleTaskStatusRailCollapsed
} from '@/store/task-status'

import { useSessionView } from './session-view'

/** Latest non-skip task status across the session's assistant messages. */
function latestTaskStatus(messages: ChatMessage[]): TaskStatus | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const status = messages[i]?.taskStatus
    if (status && !status.skip) {return status}
  }
  return null
}

function StatusField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
        {label}
      </div>
      <p className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-(--ui-text-secondary)">
        {value}
      </p>
    </div>
  )
}

/**
 * Per-session task-status rail: shows background / progress / next from the
 * latest assistant turn (model writes a [HERMES_TASK_STATUS] block that is
 * stripped from the visible body). Collapsible, globally toggleable.
 */
export function TaskStatusRail() {
  const view = useSessionView()
  const messages = useStore(view.$messages)
  const enabled = useStore($taskStatusRailEnabled)
  const collapsed = useStore($taskStatusRailCollapsed)

  const status = useMemo(() => latestTaskStatus(messages), [messages])

  if (!enabled) {return null}

  if (collapsed) {
    return (
      <div className="flex h-full w-9 shrink-0 flex-col items-center border-l border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)">
        <button
          aria-label="展开任务状态"
          className="mt-2 grid size-7 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)"
          onClick={toggleTaskStatusRailCollapsed}
          title="展开任务状态"
          type="button"
        >
          <span aria-hidden>◧</span>
        </button>
        <span
          className="mt-2 [writing-mode:vertical-rl] text-[0.625rem] font-semibold uppercase tracking-widest text-(--ui-text-tertiary)"
          style={{ transform: 'rotate(180deg)' }}
        >
          任务状态
        </span>
      </div>
    )
  }

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col overflow-hidden border-l border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)"
      data-testid="task-status-rail"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--ui-stroke-tertiary) px-3">
        <span className="text-[0.6875rem] font-semibold text-(--ui-text-secondary)">任务状态</span>
        <div className="flex items-center gap-0.5">
          <button
            aria-label="折叠任务状态"
            className="grid size-6 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)"
            onClick={toggleTaskStatusRailCollapsed}
            title="折叠"
            type="button"
          >
            <span aria-hidden>»</span>
          </button>
          <button
            aria-label="关闭任务状态"
            className="grid size-6 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)"
            onClick={toggleTaskStatusRail}
            title="关闭（可在设置中重新开启）"
            type="button"
          >
            <span aria-hidden>×</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {status ? (
          <div className="space-y-4">
            <StatusField label="背景" value={status.background} />
            <StatusField label="进度" value={status.progress} />
            <StatusField label="接下来" value={status.next} />
          </div>
        ) : (
          <p className={cn('text-[0.75rem] leading-relaxed text-(--ui-text-tertiary)')}>
            暂无任务状态。AI 在回答任务型问题时会在侧边栏更新背景、进度与下一步。
          </p>
        )}
      </div>
    </aside>
  )
}
