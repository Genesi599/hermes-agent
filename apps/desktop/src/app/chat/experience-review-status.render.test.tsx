import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { setReviewActivity } from '@/store/session'

import { ExperienceReviewStatus } from './experience-review-status'

describe('ExperienceReviewStatus review animation', () => {
  afterEach(() => {
    cleanup()
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
})
