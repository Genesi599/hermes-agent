import { atom } from 'nanostores'

/**
 * ROUTING SESSION → ROOM SESSION mapping.
 *
 * A project room's dispatched turns run in a SEPARATE routing conversation
 * (`<项目> · Hermes`), not in the room's own stored session. Both the roster
 * chips (agent-activity.ts) and the runtime-state unread marking
 * (session-states.ts) need to know "this conversation speaks into THAT room"
 * — the roster to put the dot on the room row, the unread marking to skip the
 * dot entirely when the room is the conversation on screen.
 *
 * Populated by the roster poll (every 10s from the moment the room renders);
 * read by session-states at turn-end. Leaf module on purpose: writer and
 * reader both import it, so it must not import either of them.
 */
export const $roomByRoutingSessionId = atom<Record<string, string>>({})

export function rememberRoomRouting(routingSessionId: string, roomSessionId: string): void {
  if (!routingSessionId || !roomSessionId) {
    return
  }

  const current = $roomByRoutingSessionId.get()

  if (current[routingSessionId] === roomSessionId) {
    return
  }

  $roomByRoutingSessionId.set({ ...current, [routingSessionId]: roomSessionId })
}
