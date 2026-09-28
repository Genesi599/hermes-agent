import { afterEach, describe, expect, it, vi } from 'vitest'

import { estimateStreamTokens, noteTurnStreamText, resetTurnStreamStats, $turnStreamStats } from './turn-stream-stats'

afterEach(() => {
  vi.restoreAllMocks()
  resetTurnStreamStats()
})

describe('turn-stream-stats', () => {
  it('accumulates chars and cjk counts across deltas', () => {
    noteTurnStreamText('Hello world, this is English prose. ')
    noteTurnStreamText('中文输出两句。')

    const s = $turnStreamStats.get()

    expect(s.chars).toBeGreaterThan(30)
    expect(s.cjk).toBe(6)
  })

  it('reset zeroes everything', () => {
    noteTurnStreamText('some text to count')
    resetTurnStreamStats()

    expect($turnStreamStats.get()).toEqual({ chars: 0, cjk: 0, activeMs: 0 })
  })

  it('ignores empty deltas', () => {
    noteTurnStreamText('')

    expect($turnStreamStats.get().chars).toBe(0)
  })

  it('does not count long gaps (tool turns) toward burst time', () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    noteTurnStreamText('first chunk lands')
    now += 5000 // tool round-trip — outside the burst window
    noteTurnStreamText('second chunk after the tool ran')

    expect($turnStreamStats.get().activeMs).toBe(0)
  })

  it('counts short gaps toward burst time, capped per gap', () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    noteTurnStreamText('chunk one')
    now += 50
    noteTurnStreamText('chunk two')
    now += 900 // would exceed the per-gap cap
    noteTurnStreamText('chunk three')

    // 50 (real gap) + 200 (cap applied to the 900ms gap)
    expect($turnStreamStats.get().activeMs).toBe(250)
  })

  it('estimates blended tokens: cjk ~1.5 chars/token, other ~4', () => {
    // 12 CJK chars → 8 tokens; 12 ASCII chars → 3 tokens
    expect(estimateStreamTokens({ chars: 24, cjk: 12, activeMs: 1000 })).toBe(11)
    expect(estimateStreamTokens({ chars: 40, cjk: 0, activeMs: 1000 })).toBe(10)
  })
})
