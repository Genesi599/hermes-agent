import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { setExperienceReview, setReviewActivity } from '@/store/session'

import { ExperienceReviewStatus } from './experience-review-status'
import { PRIMARY_SESSION_VIEW, SessionViewProvider } from './session-view'

describe('ExperienceReviewStatus review animation', () => {
  afterEach(() => {
    cleanup()
    setExperienceReview({ batch: 0, pending: false, phase: 'counting', threshold: 20, user_count: 0 })
    setReviewActivity(null)
  })

  it('shows the dedicated wave animation for a branch merge review', () => {
    setReviewActivity('branch-merge')
    render(<ExperienceReviewStatus />)

    expect(screen.getByText('分支合并复盘')).toBeTruthy()
    expect(
      screen.getByTestId('experience-review-status').querySelector('[data-review-animation="wave"]')
    ).not.toBeNull()
  })

  it('labels delete review separately', () => {
    setReviewActivity('delete')
    render(<ExperienceReviewStatus />)

    expect(screen.getByText('删除前复盘')).toBeTruthy()
    expect(
      screen.getByTestId('experience-review-status').querySelector('[data-review-animation="wave"]')
    ).not.toBeNull()
  })

  it('does not show the review wave while only counting normal messages', () => {
    render(<ExperienceReviewStatus />)

    expect(
      screen.getByTestId('experience-review-status').querySelector('[data-review-animation="wave"]')
    ).toBeNull()
  })

  it('reads the counter from the session view instead of the global active session', () => {
    setExperienceReview({ batch: 0, pending: false, phase: 'counting', threshold: 20, user_count: 3 })
    const tileView = {
      ...PRIMARY_SESSION_VIEW,
      $experienceReview: atom({ batch: 1, pending: false, phase: 'counting' as const, threshold: 20, user_count: 12 }),
      $reviewActivity: atom<ClientSessionState['reviewActivity']>(null),
      kind: 'tile' as const
    }

    render(
      <SessionViewProvider value={tileView}>
        <ExperienceReviewStatus />
      </SessionViewProvider>
    )

    expect(screen.getByText('复盘 12/20')).toBeTruthy()
    expect(screen.queryByText('复盘 3/20')).toBeNull()
  })
})
