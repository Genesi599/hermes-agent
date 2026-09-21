import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { sessionMatchesSearch } from './session-search'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    archived: false,
    cwd: '/home/user/projects/hermes-agent',
    ended_at: null,
    id: '20260603_090200_abcd12',
    input_tokens: 0,
    is_active: false,
    last_active: 1_000,
    message_count: 2,
    model: 'claude',
    output_tokens: 0,
    preview: 'Fix Desktop session search',
    source: 'cli',
    started_at: 1_000,
    title: 'Desktop Search Feature',
    tool_call_count: 0,
    ...overrides
  }
}

describe('sessionMatchesSearch', () => {
  it('matches loaded sessions by full and partial session id', () => {
    const session = makeSession()

    expect(sessionMatchesSearch(session, '20260603_090200_abcd12')).toBe(true)
    expect(sessionMatchesSearch(session, '090200')).toBe(true)
    expect(sessionMatchesSearch(session, 'ABCD12')).toBe(true)
  })

  it('matches projected compression sessions by lineage root id', () => {
    const session = makeSession({
      _lineage_root_id: '20260602_235959_root99',
      id: '20260603_010000_tip01'
    })

    expect(sessionMatchesSearch(session, 'root99')).toBe(true)
    expect(sessionMatchesSearch(session, '20260602')).toBe(true)
  })

  it('matches by title (preview / workspace no longer participate)', () => {
    const session = makeSession()

    // 标题命中。
    expect(sessionMatchesSearch(session, 'desktop search')).toBe(true)
    // 预览与工作目录不再参与（2026-09-21：只搜标题——否则消息正文、工具输出
    // 片段会把搜索结果弄脏，搜 book 会带出一堆含 Book 路径的 JSON）。
    expect(sessionMatchesSearch(session, 'session search')).toBe(false)
    expect(sessionMatchesSearch(session, 'hermes-agent')).toBe(false)
  })

  it('ignores git branch, source platform and aliases', () => {
    expect(sessionMatchesSearch(makeSession({ git_branch: 'feat/cool-thing' }), 'feat/cool-thing')).toBe(false)
    expect(sessionMatchesSearch(makeSession({ git_branch: 'main' }), 'main')).toBe(false)
    expect(sessionMatchesSearch(makeSession({ source: 'telegram' }), 'Telegram')).toBe(false)
    expect(sessionMatchesSearch(makeSession({ source: 'whatsapp' }), 'wa')).toBe(false)
    expect(sessionMatchesSearch(makeSession({ source: 'bluebubbles' }), 'imessage')).toBe(false)
  })

  it('does not match unrelated queries', () => {
    expect(sessionMatchesSearch(makeSession(), 'totally-unrelated')).toBe(false)
  })
})
