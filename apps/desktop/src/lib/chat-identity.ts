import userAvatar from '@/assets/avatars/user-avatar.png'

/**
 * Speaker identities for the shared transcript.
 *
 * One conversation can carry several speakers — the person, the main agent,
 * and any named producer (a cron steward, a branch worker). Named producers
 * stamp their own reply with `display_kind: 'agent_message'` +
 * `display_metadata.agent` / `.agent_avatar`; everyone else falls back to the
 * defaults here, so every bubble can say WHO spoke.
 *
 * These are display-only defaults, not security boundaries.
 */

/** The person at the keyboard. */
export const USER_SPEAKER = { name: '杨航', avatarImage: userAvatar } as const

/** The main assistant when a reply carries no producer label of its own. */
export const DEFAULT_AGENT_SPEAKER = { name: 'Hermes', avatar: 'H' } as const

export interface SpeakerIdentity {
  name: string
  /** Text glyph (an emoji, or the name's first character). */
  avatar?: string
  /** Image source; wins over the glyph when present. */
  avatarImage?: string
}
