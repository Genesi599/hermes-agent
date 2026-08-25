import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { findGroupOfPane, group, split } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree } from '@/components/pane-shell/tree/store'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import type { SessionTile } from '@/store/session-states'
import {
  $focusedRuntimeId,
  $focusedStoredSessionId,
  $sessionStates,
  $sessionTiles,
  blankDraftTile,
  focusedSessionNeedsRoute,
  markSelectionRestore,
  orderTilesByTree,
  selectionHomesToWorkspace,
  shouldMarkSessionUnread
} from '@/store/session-states'

const tile = (storedSessionId: string): SessionTile => ({ storedSessionId })
const tilePane = (id: string) => `session-tile:${id}`

describe('orderTilesByTree', () => {
  it('no-ops (null) without a tree or below two tiles', () => {
    expect(orderTilesByTree(null, [tile('a'), tile('b')])).toBeNull()
    expect(orderTilesByTree(group([tilePane('a')]), [tile('a')])).toBeNull()
  })

  it('reorders tiles to layout-tree encounter order across a split', () => {
    const tree = split('row', [group(['workspace', tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('a'), tile('b')])).toEqual([tile('b'), tile('a')])
  })

  it('returns null when the array already matches strip order (skip persist)', () => {
    const tree = split('row', [group([tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('b'), tile('a')])).toBeNull()
  })

  it('sorts not-yet-adopted tiles after placed ones, stably', () => {
    const tree = group(['workspace', tilePane('b')])

    expect(orderTilesByTree(tree, [tile('a'), tile('b'), tile('c')])).toEqual([tile('b'), tile('a'), tile('c')])
  })
})

describe('selectionHomesToWorkspace', () => {
  const tiles = [tile('a'), tile('b')]

  it('homes for a null selection or a non-tile session', () => {
    expect(selectionHomesToWorkspace(null, tiles)).toBe(true)
    expect(selectionHomesToWorkspace('c', tiles)).toBe(true)
  })

  it('skips homing when the selected id is already an open tile', () => {
    expect(selectionHomesToWorkspace('a', tiles)).toBe(false)
  })
})

describe('boot-restore selection homing (⌘R tab persistence)', () => {
  const mainGroup = () => group(['workspace', tilePane('t')], { active: tilePane('t'), id: 'main' })

  const activePane = () => {
    const tree = $layoutTree.get()

    return tree?.type === 'group' ? tree.active : null
  }

  it('a normal selection change fronts the workspace tab over an active tile', () => {
    $layoutTree.set(mainGroup())
    $selectedStoredSessionId.set('nav-1')

    expect(activePane()).toBe('workspace')
  })

  it('markSelectionRestore skips homing exactly once, so the persisted active tab survives a reload', () => {
    $layoutTree.set(mainGroup())
    markSelectionRestore()
    $selectedStoredSessionId.set('boot-1')

    // Boot restore: the tile tab the user reloaded on stays fronted.
    expect(activePane()).toBe(tilePane('t'))

    // One-shot consumed: the next selection change is a real navigation.
    $selectedStoredSessionId.set('nav-2')
    expect(activePane()).toBe('workspace')
  })
})

describe('focusedSessionNeedsRoute', () => {
  it('routes when the session is not on screen', () => {
    expect(focusedSessionNeedsRoute(null, false)).toBe(true)
    expect(focusedSessionNeedsRoute(null, true)).toBe(true)
  })

  it('routes for the ACTIVE main session while a full page covers the workspace', () => {
    expect(focusedSessionNeedsRoute('main', true)).toBe(true)
  })

  it('skips the route when the main session is already the visible chat', () => {
    expect(focusedSessionNeedsRoute('main', false)).toBe(false)
  })

  it('never routes for a tile — its pane shows the chat on any route', () => {
    expect(focusedSessionNeedsRoute('tile', true)).toBe(false)
    expect(focusedSessionNeedsRoute('tile', false)).toBe(false)
  })
})

describe('blankDraftTile', () => {
  const bound = (storedSessionId: string, runtimeId: string): SessionTile => ({ runtimeId, storedSessionId })

  const state = (messages: number, busy = false) =>
    ({ busy, messages: Array.from({ length: messages }, (_, i) => ({ id: `m${i}` })) }) as ClientSessionState

  it('finds the open tab whose session has no messages', () => {
    const tiles = [bound('a', 'run-a'), bound('b', 'run-b')]
    const states = { 'run-a': state(3), 'run-b': state(0) }

    expect(blankDraftTile(tiles, states)).toEqual(tiles[1])
  })

  it('picks the most recent blank tab when there are several', () => {
    const tiles = [bound('a', 'run-a'), bound('b', 'run-b')]
    const states = { 'run-a': state(0), 'run-b': state(0) }

    expect(blankDraftTile(tiles, states)).toEqual(tiles[1])
  })

  it('leaves a blank-but-busy tab alone — its first turn is already in flight', () => {
    expect(blankDraftTile([bound('a', 'run-a')], { 'run-a': state(0, true) })).toBeNull()
  })

  it('treats an unbound or unpublished tile as unknown, not empty', () => {
    expect(blankDraftTile([tile('a')], {})).toBeNull()
    expect(blankDraftTile([bound('a', 'run-a')], {})).toBeNull()
  })

  it('is null when every open tab holds a conversation', () => {
    expect(blankDraftTile([bound('a', 'run-a')], { 'run-a': state(2) })).toBeNull()
    expect(blankDraftTile([], {})).toBeNull()
  })
})

// ⌘⇧T used to only restore `$sessionTiles`. Adoption inserts silently
// (activate:false), so the tab came back behind the still-fronted workspace.
// Real path: register, adopt, focus — same as paneMirror + reopen.
describe('reopenLastClosedTile focuses the restored tab', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  async function setup() {
    const tree = await import('@/components/pane-shell/tree/store')
    const model = await import('@/components/pane-shell/tree/model')
    const { registry } = await import('@/contrib/registry')
    const session = await import('@/store/session')
    const states = await import('@/store/session-states')

    registry.register({
      area: 'panes',
      data: { placement: 'main', uncloseable: true },
      id: 'workspace',
      render: () => null,
      title: 'chat'
    })

    // panes ← $sessionTiles (paneMirror stub). Adoption is synchronous on
    // register, so openSessionTile + focusOpenSession works the same tick.
    const registered = new Map<string, () => void>()

    const syncTiles = () => {
      const wanted = new Set(states.$sessionTiles.get().map(t => t.storedSessionId))

      for (const id of wanted) {
        if (registered.has(id)) {
          continue
        }

        registered.set(
          id,
          registry.register({
            area: 'panes',
            data: { dock: { pane: 'workspace', pos: 'center' }, placement: 'main' },
            id: tilePane(id),
            render: () => null,
            title: id
          })
        )
      }

      for (const [id, dispose] of registered) {
        if (!wanted.has(id)) {
          dispose()
          registered.delete(id)
          tree.removeTreePane(tilePane(id))
        }
      }
    }

    states.$sessionTiles.listen(syncTiles)
    tree.watchContributedPanes()
    session.$selectedStoredSessionId.set('primary')
    tree.declareDefaultTree(model.group(['workspace'], { active: 'workspace', id: 'grp-main' }))

    states.openSessionTile('closed', 'center', 'workspace')
    states.focusOpenSession('closed')
    tree.noteActiveTreeGroup('grp-main')
    expect(findGroupOfPane(tree.$layoutTree.get()!, tilePane('closed'))?.active).toBe(tilePane('closed'))

    return { states, tree }
  }

  it('fronts the restored tab after ⌘⇧T', async () => {
    const { states, tree } = await setup()

    states.closeSessionTile('closed')
    expect(states.$sessionTiles.get().some(t => t.storedSessionId === 'closed')).toBe(false)
    expect(findGroupOfPane(tree.$layoutTree.get()!, 'workspace')?.active).toBe('workspace')

    states.reopenLastClosedTile()

    expect(states.$sessionTiles.get().some(t => t.storedSessionId === 'closed')).toBe(true)
    expect(findGroupOfPane(tree.$layoutTree.get()!, tilePane('closed'))?.active).toBe(tilePane('closed'))
    expect(tree.$activeTreeGroup.get()).toBe('grp-main')
  })
})

describe('shouldMarkSessionUnread (cron exclusion)', () => {
  it('never marks an automated cron session unread', () => {
    expect(shouldMarkSessionUnread('cron_6d5a83c11c17_20260811_093018', null, true)).toBe(false)
    expect(shouldMarkSessionUnread('cron_job_123', 'other-session', false)).toBe(false)
  })

  it('still marks a normal background completion unread', () => {
    expect(shouldMarkSessionUnread('20260811_141303_6536f5', null, true)).toBe(true)
  })
})

describe('focused session follows compression tip rotation', () => {
  const stateFor = (storedSessionId: string): ClientSessionState =>
    ({ storedSessionId }) as unknown as ClientSessionState

  const focusTilePane = (storedSessionId: string) => {
    $layoutTree.set(group([tilePane(storedSessionId)], { active: tilePane(storedSessionId), id: 'grp-tile' }))
    $activeTreeGroup.set('grp-tile')
  }

  afterEach(() => {
    $activeTreeGroup.set(null)
    $layoutTree.set(null)
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)
    $sessionTiles.set([])
    $sessionStates.set({})
  })

  it('resolves a stale tile pane id to the runtime CURRENT stored id after rotation', () => {
    $sessionTiles.set([{ runtimeId: 'rt-1', storedSessionId: 'root-1' }])
    $sessionStates.set({ 'rt-1': stateFor('tip-2') })
    $selectedStoredSessionId.set('elsewhere')
    focusTilePane('root-1')

    // The pane name froze 'root-1', the runtime moved on to 'tip-2' — focus
    // must name the conversation as it exists NOW, not the defunct pane id.
    expect($focusedStoredSessionId.get()).toBe('tip-2')
  })

  it('keeps the pane id while the tile runtime has not published a state yet', () => {
    $sessionTiles.set([{ runtimeId: 'rt-1', storedSessionId: 'root-1' }])
    focusTilePane('root-1')

    expect($focusedStoredSessionId.get()).toBe('root-1')
  })

  it('still resolves the tile runtime by the pane id, not the rotated focused id', () => {
    $sessionTiles.set([{ runtimeId: 'rt-1', storedSessionId: 'root-1' }])
    $sessionStates.set({ 'rt-1': stateFor('tip-2') })
    $activeSessionId.set('rt-primary')
    $selectedStoredSessionId.set('elsewhere')
    focusTilePane('root-1')

    expect($focusedStoredSessionId.get()).toBe('tip-2')
    expect($focusedRuntimeId.get()).toBe('rt-1')
  })

  it('falls back to the primary runtime when no tile pane is focused', () => {
    $layoutTree.set(group(['workspace'], { active: 'workspace', id: 'grp-main' }))
    $activeTreeGroup.set('grp-main')
    $selectedStoredSessionId.set('main-sel')
    $activeSessionId.set('rt-primary')

    expect($focusedStoredSessionId.get()).toBe('main-sel')
    expect($focusedRuntimeId.get()).toBe('rt-primary')
  })
})
