import { normalize } from '@/lib/text'
import type { SessionInfo } from '@/types/hermes'

import { sessionTitle } from './chat-runtime'

export function sessionMatchesSearch(session: SessionInfo, query: string): boolean {
  const needle = normalize(query)

  if (!needle) {
    return true
  }

  // 只按标题/项目名匹配（杨航 2026-09-21）。此前还把 session.preview（消息预览）、
  // cwd、git_branch、来源词也算命中，于是搜 book 会带出正文里提到 Book 路径的
  // 工具输出 / JSON 片段。搜 id（含 lineage root 前缀）保留，便于按 id 定位。
  return [session.id, session._lineage_root_id ?? '', sessionTitle(session)].some(value =>
    value.toLowerCase().includes(needle)
  )
}
