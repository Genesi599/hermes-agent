import { describe, expect, it } from 'vitest'

import type { GatewayEventPayload } from '@/lib/chat-messages'

import {
  completionErrorText,
  delegateTaskPayloads,
  hasSessionInfoStatePatch,
  reviewActivityForInternalKind,
  reviewActivityForStatusEvent,
  sessionInfoStatePatch,
  toTodoPayload
} from './utils'

describe('reviewActivityForStatusEvent', () => {
  it('distinguishes batch and branch reviews and clears only the matching mode', () => {
    expect(reviewActivityForStatusEvent('experience_review.status', 'reviewing', null)).toBe('experience')
    expect(reviewActivityForStatusEvent('branch_merge.status', 'reviewing', null)).toBe('branch-merge')
    expect(reviewActivityForStatusEvent('delete_review.status', 'reviewing', null)).toBe('delete')
    expect(reviewActivityForStatusEvent('branch_merge.status', 'queued', 'branch-merge')).toBeNull()
    expect(reviewActivityForStatusEvent('delete_review.status', 'complete', 'delete')).toBeNull()
    expect(reviewActivityForStatusEvent('branch_merge.status', 'complete', 'experience')).toBe('experience')
  })
})

describe('reviewActivityForInternalKind', () => {
  it('restores the review mode from message.start when a status event was missed', () => {
    expect(reviewActivityForInternalKind('experience_review')).toBe('experience')
    expect(reviewActivityForInternalKind('branch_merge_review')).toBe('branch-merge')
    expect(reviewActivityForInternalKind('delete_review')).toBe('delete')
    expect(reviewActivityForInternalKind('goal_continuation')).toBeNull()
  })
})

const payload = (over: Record<string, unknown>): GatewayEventPayload => over as GatewayEventPayload

describe('completionErrorText', () => {
  it('flags provider/HTTP/retry failures, ignores normal text', () => {
    expect(completionErrorText('API call failed after 3 retries: boom')).toMatch(/^API call failed/)
    expect(completionErrorText('HTTP 500 upstream')).toMatch(/^HTTP 500/)
    expect(completionErrorText('Gateway error: nope')).toMatch(/^Gateway error/)
    expect(completionErrorText('Codex response remained incomplete after 3 continuation attempts')).toMatch(
      /^Codex response remained incomplete/
    )
    expect(completionErrorText('here is your answer')).toBeNull()
    expect(completionErrorText('   ')).toBeNull()
  })
})

describe('toTodoPayload', () => {
  it('routes named todo and anonymous todos-bearing events to the todo stream', () => {
    expect(toTodoPayload(payload({ name: 'todo' }))?.tool_id).toBe('todo-live')
    expect(toTodoPayload(payload({ todos: [] }))?.name).toBe('todo')
    expect(toTodoPayload(payload({ name: 'web_search' }))).toBeUndefined()
    expect(toTodoPayload(undefined)).toBeUndefined()
  })
})

describe('sessionInfoStatePatch / hasSessionInfoStatePatch', () => {
  it('extracts only present runtime fields', () => {
    const patch = sessionInfoStatePatch(
      payload({
        model: 'gpt',
        fast: true,
        branch: 'main',
        experience_review: { batch: 2, pending: true, phase: 'reviewing', threshold: 20, user_count: 20 }
      })
    )
    expect(patch).toMatchObject({
      model: 'gpt',
      fast: true,
      branch: 'main',
      experienceReview: { batch: 2, pending: true, phase: 'reviewing', threshold: 20, user_count: 20 }
    })
    expect(hasSessionInfoStatePatch(patch)).toBe(true)
    expect(hasSessionInfoStatePatch(sessionInfoStatePatch(payload({})))).toBe(false)
  })
})

describe('delegateTaskPayloads', () => {
  it('returns [] for non-delegate events', () => {
    expect(delegateTaskPayloads(payload({ name: 'web_search' }), 'running')).toEqual([])
  })

  it('maps a running tool.start to a subagent.start spec', () => {
    const [spec] = delegateTaskPayloads(
      payload({ name: 'delegate_task', tool_id: 't1', args: { goal: 'do it' } }),
      'running',
      'tool.start'
    )

    expect(spec).toMatchObject({ event_type: 'subagent.start', goal: 'do it', status: 'running' })
  })

  it('maps completion (with error) to a failed subagent.complete', () => {
    const [spec] = delegateTaskPayloads(
      payload({ name: 'delegate_task', error: 'boom', result: { summary: 'failed run' } }),
      'complete'
    )

    expect(spec).toMatchObject({ event_type: 'subagent.complete', status: 'failed' })
  })
})
