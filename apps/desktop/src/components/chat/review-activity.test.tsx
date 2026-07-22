import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $reviewActivityBySessionId, setSessionReviewActivity } from '@/store/session'

import { ReviewActivityPulse, ReviewActivityUnderline } from './review-activity'

describe('review activity indicators', () => {
  afterEach(() => {
    cleanup()
    setSessionReviewActivity('session-a', null)
  })

  it('renders compact wave and segmented sidebar underline', () => {
    const { container } = render(
      <>
        <ReviewActivityPulse compact />
        <ReviewActivityUnderline />
      </>
    )

    expect(container.querySelector('[data-review-animation="wave"]')?.children).toHaveLength(5)
    expect(container.querySelector('[data-review-animation="sidebar-wave"]')?.children).toHaveLength(5)
  })

  it('tracks review activity by stored session id', () => {
    setSessionReviewActivity('session-a', 'branch-merge')
    expect($reviewActivityBySessionId.get()).toEqual({ 'session-a': 'branch-merge' })

    setSessionReviewActivity('session-a', null)
    expect($reviewActivityBySessionId.get()).toEqual({})
  })
})
