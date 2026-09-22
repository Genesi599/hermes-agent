/** Merge a change-feed delta into a session list WITHOUT a full re-pull.
 *
 * Rows keep their position when replaced (Map insertion order); rows the list
 * never carried are appended (they sort wherever the consumer sorts); deleted
 * ids not present are a no-op. Returns the SAME array when the delta touched
 * nothing so downstream `useStore` subscribers skip the re-render.
 */
import type { SessionInfo } from '@/hermes'
import type { ChangeFeedEvent } from '@/hermes'

export function applySessionDelta(
  rows: SessionInfo[],
  events: ChangeFeedEvent[],
  upserts: SessionInfo[]
): SessionInfo[] {
  const deletes = new Set(events.filter(event => event.table === 'sessions' && event.kind === 'delete').map(event => event.pk))
  const touched = events.some(event => event.table === 'sessions')

  if (!touched) {
    return rows
  }

  const byId = new Map(rows.map(row => [row.id, row]))

  for (const row of upserts) {
    const prev = byId.get(row.id)
    if (prev) {
      // MONOTONIC ACTIVITY (2026-09-19): a delta's row read can race the
      // activity touch (channel write vs sessions-row update) and arrive with
      // a STALE last_active. Overwriting wholesale made active rows oscillate
      // between distant list slots (Book: 401↔899px every refresh — the
      // "whole project disappears for 1-2s" report). Same guard as
      // mergeSessionPage: keep the fresher stamp.
      const last_active = Math.max(prev.last_active ?? 0, row.last_active ?? 0)
      byId.set(row.id, last_active === row.last_active ? row : { ...row, last_active })
    } else {
      byId.set(row.id, row)
    }
  }

  const next = [...byId.values()].filter(row => !deletes.has(row.id))

  return next
}
