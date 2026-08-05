import { afterEach, describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { $pinnedSessionIds } from './layout'
import { $sessions } from './session'
import {
  expandPinnedSessionFamilies,
  expandSessionFamilyMemberIds,
  isSessionFamilyPinned,
  pinSessionFamily,
  sessionFamilyPinIds,
  splitActiveSessionFamilies,
  unpinSessionFamily
} from './session-pins'

const session = (id: string, parentSessionId: null | string = null, lineageRootId: null | string = null) =>
  ({
    _lineage_root_id: lineageRootId,
    id,
    parent_session_id: parentSessionId
  }) as SessionInfo

const family = [
  session('parent'),
  session('child-a', 'parent'),
  session('grandchild', 'child-a'),
  session('child-b', 'parent')
]

afterEach(() => {
  $pinnedSessionIds.set([])
  $sessions.set([])
})

describe('session Branch family pins', () => {
  it('resolves the whole tree from either the parent or a nested child', () => {
    expect(sessionFamilyPinIds(family, 'parent')).toEqual(['parent', 'child-a', 'grandchild', 'child-b'])
    expect(sessionFamilyPinIds(family, 'grandchild')).toEqual(['parent', 'child-a', 'grandchild', 'child-b'])
  })

  it('uses durable lineage-root ids across compressed sessions', () => {
    const compressed = [session('parent-tip', null, 'parent-root'), session('child-tip', 'parent-tip', 'child-root')]

    expect(sessionFamilyPinIds(compressed, 'child-tip')).toEqual(['parent-root', 'child-root'])
    expect(sessionFamilyPinIds(compressed, 'parent-root')).toEqual(['parent-root', 'child-root'])
  })

  it('expands a legacy parent-only pin to children created later', () => {
    expect(expandPinnedSessionFamilies(family, ['parent'])).toEqual(['parent', 'child-a', 'grandchild', 'child-b'])
  })

  it('promotes a whole family when any parent or nested child is active', () => {
    expect([...expandSessionFamilyMemberIds([...family, session('other')], ['grandchild'])]).toEqual([
      'parent',
      'child-a',
      'grandchild',
      'child-b'
    ])
    expect([...expandSessionFamilyMemberIds(family, ['parent'])]).toEqual([
      'parent',
      'child-a',
      'grandchild',
      'child-b'
    ])
  })

  it('matches working or unread ids through compression lineage roots', () => {
    const compressed = [session('parent-tip', null, 'parent-root'), session('child-tip', 'parent-root', 'child-root')]

    expect([...expandSessionFamilyMemberIds(compressed, ['child-root'])]).toEqual(['parent-tip', 'child-tip'])
  })

  it('pinning a child pins its parent, siblings, and descendants', () => {
    $sessions.set(family)

    pinSessionFamily('child-a')

    expect($pinnedSessionIds.get()).toEqual(['parent', 'child-a', 'grandchild', 'child-b'])
    expect(isSessionFamilyPinned('child-b')).toBe(true)
  })

  it('unpinning either direction removes the family but preserves unrelated pins', () => {
    $sessions.set([...family, session('unrelated')])
    $pinnedSessionIds.set(['unrelated', 'parent', 'child-a', 'grandchild', 'child-b'])

    unpinSessionFamily('grandchild')

    expect($pinnedSessionIds.get()).toEqual(['unrelated'])
    expect(isSessionFamilyPinned('parent')).toBe(false)
  })

  it('moves a pinned active family into the active bucket until it is read', () => {
    const unrelated = session('unrelated')
    const sessions = [...family, unrelated]

    const active = splitActiveSessionFamilies(sessions, [family[0], unrelated], ['child-a'])

    expect(active.activeSessions.map(item => item.id)).toEqual(['parent', 'child-a', 'grandchild', 'child-b'])
    expect(active.inactivePinnedSessions.map(item => item.id)).toEqual(['unrelated'])

    const settled = splitActiveSessionFamilies(sessions, [family[0], unrelated], [])
    expect(settled.activeSessions).toEqual([])
    expect(settled.inactivePinnedSessions.map(item => item.id)).toEqual(['parent', 'unrelated'])
  })
})
