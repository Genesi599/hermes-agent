import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { setReviewActivity } from '@/store/session'

import { ExperienceReviewStatus } from './experience-review-status'

describe('ExperienceReviewStatus review animation', () => {
  afterEach(() => {
    cleanup()
    setReviewActivity(null)
  })

  it('shows the dedicated Fourier loader for a branch merge review', () => {
    setReviewActivity('branch-merge')
    render(<ExperienceReviewStatus />)

    expect(screen.getByText('分支合并复盘')).toBeTruthy()
    expect(screen.getByTestId('experience-review-status').querySelector('svg')).not.toBeNull()
  })

  it('labels delete review separately', () => {
    setReviewActivity('delete')
    render(<ExperienceReviewStatus />)

    expect(screen.getByText('删除前复盘')).toBeTruthy()
    expect(screen.getByTestId('experience-review-status').querySelector('svg')).not.toBeNull()
  })
})
