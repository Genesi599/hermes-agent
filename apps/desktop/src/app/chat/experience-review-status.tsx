import { useStore } from '@nanostores/react'

import { reviewActivityLabel, ReviewActivityPulse } from '@/components/chat/review-activity'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import type { ExperienceReviewInfo } from '@/types/hermes'

import { useSessionView } from './session-view'

export function experienceReviewLabel(state: ExperienceReviewInfo): string {
  if (state.phase === 'reviewing') {
    return `复盘中 · ${state.user_count}/${state.threshold}`
  }

  if (state.phase === 'queued') {
    return `待复盘 · ${state.user_count}/${state.threshold}`
  }

  return `复盘 ${state.user_count}/${state.threshold}`
}

export function ExperienceReviewStatus() {
  const view = useSessionView()
  const state = useStore(view.$experienceReview)
  const reviewActivity = useStore(view.$reviewActivity)
  const reviewing = state.phase === 'reviewing'
  const activeReview = reviewActivity ?? (reviewing ? 'experience' : null)
  const label = activeReview
    ? `${reviewActivityLabel(activeReview)}${activeReview === 'experience' ? ` · ${state.user_count}/${state.threshold}` : ''}`
    : experienceReviewLabel(state)

  return (
    <span
      aria-live="polite"
      className={cn(
        'pointer-events-auto flex h-6 min-w-[6.75rem] shrink-0 items-center justify-center gap-1 rounded border border-(--ui-stroke-tertiary) px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) [-webkit-app-region:no-drag]',
        activeReview && 'border-teal-500/25 text-teal-600/85 dark:text-teal-300/80'
      )}
      data-testid="experience-review-status"
      title={`第 ${state.batch + 1} 批 · ${label}`}
    >
      {activeReview ? (
        <ReviewActivityPulse className="text-teal-500/90" />
      ) : (
        <Codicon name="checklist" size="0.75rem" />
      )}
      <span>{label}</span>
    </span>
  )
}
