import { describe, expect, it } from 'vitest'

import type { ChangeFeedEvent, SessionInfo } from '@/hermes'

import { applySessionDelta } from './session-deltas'

const row = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ ended_at: null, id, input_tokens: 0, is_active: false, last_active: 0, message_count: 0,
     model: null, output_tokens: 0, preview: null, profile: 'default', source: null,
     started_at: 0, title: null, ...over }) as SessionInfo

const ev = (pk: string, kind: 'delete' | 'upsert'): ChangeFeedEvent =>
  ({ kind, pk, seq: 1, table: 'sessions' })

describe('applySessionDelta', () => {
  it('replaces a changed row in place and keeps order', () => {
    const rows = [row('a'), row('b'), row('c')]
    const next = applySessionDelta(rows, [ev('b', 'upsert')], [row('other'), row('b', { title: 'renamed' })])

    expect(next.map(r => r.id)).toEqual(['a', 'b', 'c', 'other'])
    expect(next[1].title).toBe('renamed')
  })

  it('removes deleted rows and ignores deletes for ids not present', () => {
    const rows = [row('a'), row('b')]
    const next = applySessionDelta(rows, [ev('a', 'delete'), ev('zz', 'delete')], [])

    expect(next.map(r => r.id)).toEqual(['b'])
  })

  it('returns the same array when no session rows were touched', () => {
    const rows = [row('a')]
    const events: ChangeFeedEvent[] = [{ kind: 'upsert', pk: '5', seq: 2, table: 'messages' }]

    expect(applySessionDelta(rows, events, [])).toBe(rows)
  })
})
