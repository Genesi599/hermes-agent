import { afterEach, describe, expect, it } from 'vitest'

import { $profileBySessionId, rememberSessionProfile } from './session-profile-hint'

afterEach(() => {
  $profileBySessionId.set({})
})

describe('session-profile-hint', () => {
  it('records id → owner profile', () => {
    rememberSessionProfile('20260920_085919_01c1a1', 'plotter')

    expect($profileBySessionId.get()['20260920_085919_01c1a1']).toBe('plotter')
  })

  it('overwrites a stale owner with the newest poll', () => {
    rememberSessionProfile('sid', 'old-owner')
    rememberSessionProfile('sid', 'new-owner')

    expect($profileBySessionId.get()['sid']).toBe('new-owner')
  })

  it('ignores blank ids or profiles', () => {
    rememberSessionProfile('', 'plotter')
    rememberSessionProfile('sid', '   ')

    expect($profileBySessionId.get()).toEqual({})
  })

  it('keeps entries stable when the same pair republishes', () => {
    rememberSessionProfile('sid', 'plotter')
    const first = $profileBySessionId.get()

    rememberSessionProfile('sid', 'plotter')

    expect($profileBySessionId.get()).toBe(first)
  })
})
