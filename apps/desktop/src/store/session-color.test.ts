import { afterEach, describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { $sessions } from './session'
import { $sessionColorById, $sessionColorOverrides, sessionColorFor, setSessionColorOverride } from './session-color'

let nextId = 0

function makeSession(cwd: null | string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    archived: false,
    cwd,
    ended_at: null,
    id: `s${nextId++}`,
    input_tokens: 0,
    is_active: false,
    last_active: 1_000,
    message_count: 1,
    model: 'claude',
    output_tokens: 0,
    preview: null,
    source: 'cli',
    started_at: 1_000,
    title: null,
    tool_call_count: 0,
    ...overrides
  }
}

afterEach(() => {
  $sessions.set([])
  $sessionColorOverrides.set({})
})

describe('$sessionColorById', () => {
  it('gives independent conversations stable, distinct automatic colors', () => {
    const a = makeSession('/www/app/src', { id: 'alpha' })
    const b = makeSession('/other/place', { id: 'beta' })
    $sessions.set([a, b])

    const map = $sessionColorById.get()

    expect(map[a.id]).toBeTruthy()
    expect(map[b.id]).toBeTruthy()
    expect(map[a.id]).not.toBe(map[b.id])
  })

  it('does not repeat an automatic color among top-level conversations', () => {
    const roots = Array.from({ length: 32 }, (_, index) =>
      makeSession(null, { id: `root-${index}`, started_at: index + 1 })
    )

    $sessions.set(roots)

    const colors = roots.map(session => $sessionColorById.get()[session.id])
    expect(new Set(colors).size).toBe(roots.length)
  })

  it('gives every branch in a conversation tree its parent color', () => {
    const parent = makeSession('/www/app', { id: 'parent' })
    const child = makeSession('/www/app', { id: 'child', parent_session_id: 'parent' })
    const grandchild = makeSession('/www/app', { id: 'grandchild', parent_session_id: 'child' })

    $sessions.set([parent, child, grandchild])

    const map = $sessionColorById.get()
    expect(map[child.id]).toBe(map[parent.id])
    expect(map[grandchild.id]).toBe(map[parent.id])
  })

  it('keeps sibling branches aligned when their unloaded parent is outside the page', () => {
    const childA = makeSession('/www/app', { id: 'child-a', parent_session_id: 'missing-parent' })
    const childB = makeSession('/www/app', { id: 'child-b', parent_session_id: 'missing-parent' })

    $sessions.set([childA, childB])

    expect($sessionColorById.get()[childA.id]).toBe($sessionColorById.get()[childB.id])
  })
})

describe('$sessionColorOverrides', () => {
  it('an override on the parent wins for every branch', () => {
    const parent = makeSession('/www/app', { id: 'parent' })
    const child = makeSession('/www/app', { id: 'child', parent_session_id: 'parent' })

    $sessions.set([parent, child])
    setSessionColorOverride(parent.id, '#ff0000')

    expect($sessionColorById.get()[parent.id]).toBe('#ff0000')
    expect($sessionColorById.get()[child.id]).toBe('#ff0000')
  })

  it('keys on the durable lineage id so a color survives compression', () => {
    // The live id rotates on auto-compression; the override is stored against the
    // lineage root, so the continuation tip still resolves to the same color.
    const root = makeSession('/x', { id: 'root' })
    const tip = makeSession('/x', { id: 'tip', _lineage_root_id: 'root' })

    setSessionColorOverride('root', '#abcdef')

    $sessions.set([tip])
    expect($sessionColorById.get().tip).toBe('#abcdef')
  })
})

describe('sessionColorFor', () => {
  it('reads a single session through the same shared map', () => {
    const a = makeSession('/www/app')

    $sessions.set([a])

    expect(sessionColorFor(a)).toBe($sessionColorById.get()[a.id])
  })

  it('returns undefined for a null/absent session', () => {
    expect(sessionColorFor(null)).toBeUndefined()
    expect(sessionColorFor(undefined)).toBeUndefined()
  })
})
