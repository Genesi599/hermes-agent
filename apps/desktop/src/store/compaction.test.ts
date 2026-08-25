import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $compactingSessions,
  sessionCompacting,
  sessionCompactingText,
  setSessionCompacting
} from './compaction'

describe('compaction store', () => {
  beforeEach(() => $compactingSessions.set({}))

  afterEach(() => $compactingSessions.set({}))

  it('tracks compaction per session independently', () => {
    setSessionCompacting('session-a', true)
    setSessionCompacting('session-b', true)

    expect($compactingSessions.get()).toEqual({ 'session-a': '', 'session-b': '' })
  })

  it('scopes the view to the session asked for, not whichever is active', () => {
    setSessionCompacting('session-a', true)

    expect(sessionCompacting('session-a').get()).toBe(true)
    expect(sessionCompacting('session-b').get()).toBe(false)
  })

  it('stores the backend status text and updates it on re-emits', () => {
    setSessionCompacting(
      'session-a',
      true,
      '🗜️ Compacting context — summarizing earlier conversation (~414,406 tokens, 461 messages)...'
    )

    expect(sessionCompactingText('session-a').get()).toBe(
      '🗜️ Compacting context — summarizing earlier conversation (~414,406 tokens, 461 messages)...'
    )
    expect(sessionCompacting('session-a').get()).toBe(true)

    setSessionCompacting(
      'session-a',
      true,
      '🗜️ Compacting context — summarizing earlier conversation (still working, 2m 05s elapsed)...'
    )

    expect(sessionCompactingText('session-a').get()).toBe(
      '🗜️ Compacting context — summarizing earlier conversation (still working, 2m 05s elapsed)...'
    )
  })

  it('keeps the previous text when an active update carries no text', () => {
    setSessionCompacting('session-a', true, '🗜️ Compacting context — summarizing...')

    setSessionCompacting('session-a', true)
    setSessionCompacting('session-a', true, '')

    expect(sessionCompactingText('session-a').get()).toBe('🗜️ Compacting context — summarizing...')
  })

  it('reads as empty text for a session that never received one', () => {
    setSessionCompacting('session-a', true)

    expect(sessionCompactingText('session-a').get()).toBe('')
    expect(sessionCompactingText('session-b').get()).toBe('')
  })

  it('clears a session without disturbing the others', () => {
    setSessionCompacting('session-a', true)
    setSessionCompacting('session-b', true, 'still working')

    setSessionCompacting('session-a', false)

    expect($compactingSessions.get()).toEqual({ 'session-b': 'still working' })
    expect(sessionCompactingText('session-a').get()).toBe('')
  })

  it('is a no-op when clearing an unknown session', () => {
    setSessionCompacting('session-a', true)
    const before = $compactingSessions.get()

    setSessionCompacting('session-missing', false)

    expect($compactingSessions.get()).toBe(before)
  })
})
