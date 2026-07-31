import { computed } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import { $sessions, sessionPinId } from '@/store/session'
import type { ProjectInfo, SessionInfo } from '@/types/hermes'

// Per-conversation color overrides. They are keyed by the branch family's root
// so a chosen color applies to the parent and every branch, and survives
// auto-compression's session-id rotation.
export const $sessionColorOverrides = persistentAtom<Record<string, string>>(
  'hermes.desktop.sessionColors',
  {},
  Codecs.stringRecord
)

// Set a conversation family's override (null clears it → its automatic color).
export function setSessionColorOverride(durableId: string, color: null | string): void {
  const prev = $sessionColorOverrides.get()

  if (color) {
    $sessionColorOverrides.set({ ...prev, [durableId]: color })
  } else if (durableId in prev) {
    const next = { ...prev }
    delete next[durableId]
    $sessionColorOverrides.set(next)
  }
}

function sessionLookup(sessions: SessionInfo[]): Map<string, SessionInfo> {
  const lookup = new Map<string, SessionInfo>()

  for (const session of sessions) {
    lookup.set(session.id, session)
    lookup.set(sessionPinId(session), session)
  }

  return lookup
}

/**
 * Stable identity for a visible conversation tree. Branches inherit their
 * top-most parent's identity; compression continuations retain their own
 * lineage root. A missing ancestor still gives all of its direct children the
 * same deterministic key until the parent appears in a later page.
 */
export function sessionColorFamilyId(session: SessionInfo, sessions: SessionInfo[]): string {
  const lookup = sessionLookup(sessions)
  const lineage = [sessionPinId(session)]
  const visited = new Set<string>([session.id, sessionPinId(session)])
  let current = session

  while (current.parent_session_id) {
    const parentId = current.parent_session_id.trim()

    if (!parentId) {
      break
    }

    const parent = lookup.get(parentId)

    if (!parent) {
      return parentId
    }

    const parentKey = sessionPinId(parent)
    lineage.push(parentKey)

    if (visited.has(parent.id) || visited.has(parentKey)) {
      return [...lineage].sort()[0]
    }

    visited.add(parent.id)
    visited.add(parentKey)
    current = parent
  }

  return sessionPinId(current)
}

const SESSION_COLOR_PALETTE = [
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#a3e635',
  '#4ade80',
  '#2dd4bf',
  '#22d3ee',
  '#38bdf8',
  '#60a5fa',
  '#818cf8',
  '#a78bfa',
  '#c084fc',
  '#e879f9',
  '#f472b6',
  '#fb7185',
  '#fdba74',
  '#fde047',
  '#bef264',
  '#86efac',
  '#5eead4',
  '#67e8f9',
  '#7dd3fc',
  '#93c5fd',
  '#c4b5fd'
] as const

function stableColorHash(value: string): number {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

function automaticColorsByFamily(
  familyBySessionId: Map<string, string>,
  overrides: Record<string, string>,
  sessions: SessionInfo[]
): Map<string, string> {
  const firstStartedAtByFamily = new Map<string, number>()

  for (const session of sessions) {
    const familyId = familyBySessionId.get(session.id) ?? sessionPinId(session)
    const firstStartedAt = firstStartedAtByFamily.get(familyId) ?? Number.POSITIVE_INFINITY
    firstStartedAtByFamily.set(familyId, Math.min(firstStartedAt, session.started_at || session.last_active || 0))
  }

  const colors = new Map<string, string>()
  const usedColors = new Set(Object.values(overrides))

  const families = [...firstStartedAtByFamily.entries()].sort(
    ([aId, aStartedAt], [bId, bStartedAt]) => aStartedAt - bStartedAt || aId.localeCompare(bId)
  )

  for (const [familyId] of families) {
    const hash = stableColorHash(familyId)
    let color: string | undefined

    for (let attempt = 0; attempt < SESSION_COLOR_PALETTE.length; attempt += 1) {
      const candidate = SESSION_COLOR_PALETTE[(hash + attempt * 7) % SESSION_COLOR_PALETTE.length]

      if (!usedColors.has(candidate)) {
        color = candidate

        break
      }
    }

    for (let attempt = 0; !color; attempt += 1) {
      const hue = Math.round((hash + attempt * 137.508) % 360)
      const candidate = `hsl(${hue} 70% ${60 + (attempt % 3) * 5}%)`

      if (!usedColors.has(candidate)) {
        color = candidate
      }
    }

    colors.set(familyId, color)

    usedColors.add(color)
  }

  return colors
}

// The resolved color for every session, keyed by live session id — the ONE
// source of truth both the sidebar rows and the pane tabs read, so the two
// surfaces can never drift. Recomputed only when the session list or overrides
// change (all cold atoms; the working/streaming pulse lives in
// $sessionStates, so a busy flip never rebuilds this), and every consumer reads
// it as an O(1) lookup rather than re-deriving membership per render.
//
// Precedence in one place: an explicit per-session override wins over the
// inherited project color. Agent-set color (#66565 layer 3) slots in here too.
function resolveSessionColor(
  session: SessionInfo,
  projects: ProjectInfo[],
  overrides: Record<string, string>
): string | undefined {
  return overrides[sessionPinId(session)] ?? sessionProjectColor(session, projects) ?? undefined
}

export const $sessionColorById = computed(
  [$sessions, $sessionColorOverrides],
  (sessions, overrides) => {
    const map: Record<string, string> = {}
    const familyBySessionId = new Map<string, string>()
    const overrideByFamily = new Map<string, string>()

    for (const session of sessions) {
      const color = resolveSessionColor(session, projects, overrides)

      const override = overrides[familyId] ?? overrides[sessionPinId(session)]

      if (override && !overrideByFamily.has(familyId)) {
        overrideByFamily.set(familyId, override)
      }
    }

    const automaticColors = automaticColorsByFamily(familyBySessionId, Object.fromEntries(overrideByFamily), sessions)

    for (const session of sessions) {
      const familyId = familyBySessionId.get(session.id) ?? sessionPinId(session)
      map[session.id] = overrideByFamily.get(familyId) ?? automaticColors.get(familyId)!
    }

    return map
  }
)

// The color for a single session object (the tabs already hold the SessionInfo
// they render, so they resolve through the same map the sidebar reads). A row
// that isn't in `$sessions` — e.g. a project-tree session older than the
// paginated recents page, opened as a tab — misses the map, so fall back to the
// same resolver the map is built from.
export function sessionColorFor(session: null | SessionInfo | undefined): string | undefined {
  if (!session) {
    return undefined
  }

  return (
    $sessionColorById.get()[session.id] ?? resolveSessionColor(session, $projects.get(), $sessionColorOverrides.get())
  )
}
