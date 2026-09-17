/**
 * CHANNELS — the group chat as a first-class entity (client side).
 *
 * A channel is where agents and the human exchange information. It owns its own
 * messages and is NOT a session: posting a line is an INSERT on the backend, not
 * a model turn, so the room stays a place rather than becoming somebody's
 * conversation. Agents post through their own delivery path (their outbox →
 * `channel_messages`); only the human's lines come through this client.
 *
 * The dashboard API sits behind the desktop bridge's own auth, so these calls go
 * through `window.hermesDesktop.api` like every other session call.
 */

export interface Channel {
  created_at: number
  id: string
  last_routed_message_id?: null | number
  message_count: number
  project: string
  title: string
  updated_at: number
}

export interface ChannelMessage {
  author_avatar: null | string
  author_kind: 'agent' | 'human' | 'system'
  author_label: null | string
  channel_id: string
  content: string
  display_kind?: null | string
  display_metadata?: null | Record<string, unknown>
  id: number
  role: string
  routed_at?: null | number
  timestamp: number
}

function bridge() {
  const desktop = window.hermesDesktop

  if (!desktop?.api) {
    throw new Error('Hermes Desktop bridge is unavailable')
  }

  return desktop
}

/** Every channel, newest activity first. Cheap enough to call per room open. */
export async function listChannels(): Promise<Channel[]> {
  const result = await bridge().api<{ channels: Channel[] }>({ path: '/api/channels' })

  return result?.channels ?? []
}

/** The channel for a project, or null when that project has no room yet. */
export async function channelForProject(project: string): Promise<Channel | null> {
  const name = project.trim()

  if (!name) {
    return null
  }

  const channels = await listChannels()

  return channels.find(channel => channel.project === name) ?? null
}

export async function fetchChannelMessages(channelId: string, limit = 200): Promise<ChannelMessage[]> {
  const result = await bridge().api<{ messages: ChannelMessage[] }>({
    path: `/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`
  })

  return result?.messages ?? []
}

/**
 * Post a HUMAN line. Recorded, not answered: the backend inserts the row and
 * nudges the routing watchdog, which is where Hermes decides who it concerns —
 * so this returns as soon as the line is in the room.
 */
export async function postChannelMessage(channelId: string, content: string): Promise<number | null> {
  const text = content.trim()

  if (!text) {
    return null
  }

  const result = await bridge().api<{ message_id: number }>({
    body: { content: text },
    method: 'POST',
    path: `/api/channels/${encodeURIComponent(channelId)}/messages`
  })

  return result?.message_id ?? null
}
