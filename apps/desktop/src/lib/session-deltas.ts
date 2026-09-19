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
    byId.set(row.id, row)
  }

  const next = [...byId.values()].filter(row => !deletes.has(row.id))

  return next
}
