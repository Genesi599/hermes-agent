import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/hermes'

import { descendantBranchMergeOrder } from './index'

function session(id: string, parentSessionId?: string): SessionInfo {
  return { id, parent_session_id: parentSessionId ?? null } as SessionInfo
}

describe('descendantBranchMergeOrder', () => {
  it('orders descendants deepest-first and excludes unrelated sessions', () => {
    const ordered = descendantBranchMergeOrder(
      [
        session('parent'),
        session('child-a', 'parent'),
        session('unrelated'),
        session('grandchild', 'child-a'),
        session('child-b', 'parent')
      ],
      'parent'
    )

    expect(ordered.map(item => item.id)).toEqual(['grandchild', 'child-a', 'child-b'])
  })

  it('stops safely when malformed parent links contain a cycle', () => {
    expect(descendantBranchMergeOrder([session('child', 'parent'), session('parent', 'child')], 'parent')).toEqual([
      session('child', 'parent')
    ])
  })
})
