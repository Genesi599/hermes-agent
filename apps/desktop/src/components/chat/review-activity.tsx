import type { FC } from 'react'

import { cn } from '@/lib/utils'

export type ReviewActivity = 'branch-merge' | 'delete' | 'experience'

export function reviewActivityLabel(activity: ReviewActivity): string {
  if (activity === 'branch-merge') {
    return '分支合并复盘'
  }

  if (activity === 'delete') {
    return '删除前复盘'
  }

  return '批次经验复盘'
}

export const ReviewActivityPulse: FC<{ className?: string; compact?: boolean }> = ({ className, compact = false }) => (
  <span
    aria-hidden="true"
    className={cn(
      'review-activity-wave inline-flex shrink-0 items-center justify-center',
      compact ? 'h-3 w-4 gap-px' : 'h-5 w-8 gap-0.5',
      className
    )}
    data-review-animation="wave"
  >
    {Array.from({ length: 5 }, (_, index) => (
      <span className={cn('rounded-full bg-current', compact ? 'h-2.5 w-px' : 'h-4 w-0.5')} key={index} />
    ))}
  </span>
)

export const ReviewActivityUnderline: FC<{ className?: string }> = ({ className }) => (
  <span aria-hidden="true" className={cn('review-session-underline', className)} data-review-animation="sidebar-wave">
    {Array.from({ length: 5 }, (_, index) => (
      <span key={index} />
    ))}
  </span>
)
