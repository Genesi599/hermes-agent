import { describe, expect, it } from 'vitest'

import { reviewActivityLabel } from '@/components/assistant-ui/thread/status'

import { experienceReviewLabel } from './experience-review-status'

describe('experienceReviewLabel', () => {
  it('shows the durable counter while collecting user turns', () => {
    expect(experienceReviewLabel({ batch: 1, pending: false, phase: 'counting', threshold: 20, user_count: 7 })).toBe(
      '复盘 7/20'
    )
  })

  it('shows queued and live review phases', () => {
    expect(experienceReviewLabel({ batch: 1, pending: true, phase: 'queued', threshold: 20, user_count: 20 })).toBe(
      '待复盘 · 20/20'
    )
    expect(experienceReviewLabel({ batch: 1, pending: true, phase: 'reviewing', threshold: 20, user_count: 20 })).toBe(
      '复盘中 · 20/20'
    )
  })
})

describe('reviewActivityLabel', () => {
  it('uses distinct labels for batch and branch review animations', () => {
    expect(reviewActivityLabel('experience')).toBe('批次经验复盘')
    expect(reviewActivityLabel('branch-merge')).toBe('分支合并复盘')
    expect(reviewActivityLabel('delete')).toBe('删除前复盘')
  })
})
