import type { CronJob } from '@/types/hermes'

/** One agent that speaks in a conversation. */
export interface SessionAgent {
  label: string
  avatar?: string
  /** The agent's Hermes profile — where its own conversation lives. */
  profile?: string
}

/** The room's own maintainer's display name — also the roster's first chip. */
const MAIN_AGENT_LABEL = 'Hermes'

// `attach_to_session` / `target_session_id` / `agent_label` / `agent_avatar` /
// `agent_profile` are emitted by the cron API for producer-labelled jobs, but
// whether they are on the shared `CronJob` type depends on what else is
// in flight in this repo — so read them structurally rather than depending on
// a type this file does not own.
function str(source: unknown, key: string): string {
  if (!source || typeof source !== 'object') {
    return ''
  }

  const value = (source as Record<string, unknown>)[key]

  return typeof value === 'string' ? value.trim() : ''
}

function flag(source: unknown, key: string): boolean {
  if (!source || typeof source !== 'object') {
    return false
  }

  return (source as Record<string, unknown>)[key] === true
}

/**
 * The agents participating in `sessionId`.
 *
 * Derived, not declared: a job whose output is attached INTO a conversation
 * (`attach_to_session` + `target_session_id`) and that carries a producer label
 * is, by construction, an agent speaking in that conversation. So the roster
 * follows the delivery wiring — add a delivery job for an agent and it appears
 * under the parent session; remove it and it goes away.
 */
export function agentsForSession(jobs: CronJob[] | undefined, sessionId: string | undefined): SessionAgent[] {
  if (!jobs?.length || !sessionId) {
    return []
  }

  const target = sessionId.trim()
  const agents: SessionAgent[] = []
  const seen = new Set<string>()

  for (const job of jobs) {
    if (!flag(job, 'attach_to_session')) {
      continue
    }

    if (str(job, 'target_session_id') !== target) {
      continue
    }

    const label = str(job, 'agent_label')

    // The room's maintainer is rendered by the roster ITSELF (it owns the
    // conversation the row belongs to, and its chip is the first one). Its
    // delivery job exists so its replies can be posted like anyone else's —
    // that job must not add a second chip for it.
    if (!label || label === MAIN_AGENT_LABEL || seen.has(label)) {
      continue
    }

    seen.add(label)
    agents.push({
      label,
      avatar: str(job, 'agent_avatar') || undefined,
      profile: str(job, 'agent_profile') || undefined
    })
  }

  return agents
}

/**
 * Profiles that ARE agents (they deliver into conversations via a job).
 *
 * Used to keep an agent's own conversation out of the flat session list: an
 * agent speaks *inside* the parent conversation (its roster), so its session is
 * a child of that conversation, not a standalone row beside it.
 */
export function agentProfileSet(jobs: CronJob[] | undefined): Set<string> {
  const profiles = new Set<string>()

  for (const job of jobs ?? []) {
    const profile = str(job, 'agent_profile')

    if (profile) {
      profiles.add(profile)
    }
  }

  return profiles
}

/** Hermes's display name — `chat-identity.ts`'s DEFAULT_AGENT_SPEAKER.name.
 *  Duplicated as a literal so this module (pure, no assets) stays importable
 *  from anywhere. */
const HERMES_NAME = 'Hermes'

/** The separator `agent_session_name.py` writes: `项目 · 智能体`. */
const AGENT_TITLE_SEPARATOR = ' · '

/** `<项目> · Hermes`, with the dedupe counter the naming script appends. */
const HERMES_CONVERSATION_RE = new RegExp(`${AGENT_TITLE_SEPARATOR}${HERMES_NAME}(?: \\(\\d+\\))?$`)

/**
 * Is this one of HERMES's own project conversations (`星阶 · Hermes`)?
 *
 * Hermes has a project conversation exactly like every other agent — but it is
 * NOT a delivery agent, so `agentProfileSet` can never recognize it: it lives
 * in the DEFAULT profile, the same one your own conversations live in, so
 * filtering by profile would take your chats with it. The NAME is the only
 * signal available, and it is a reliable one because the naming convention is
 * enforced at dispatch time. A conversation you named yourself with a
 * ` · Hermes` suffix is the accepted false positive.
 *
 * Hermes's conversations are therefore hidden from the session list for the
 * same reason an agent's are: it speaks inside its conversations, so its own
 * conversations are children of them (reached from the roster), not standalone
 * rows beside them.
 */
export function isHermesConversation(title: null | string | undefined): boolean {
  return HERMES_CONVERSATION_RE.test((title ?? '').trim())
}

/**
 * The identity of the agent whose OWN conversation this is (`steward` → 🎩 管家),
 * from the same delivery wiring the roster derives its agents from.
 *
 * Needed because a message only carries a producer label when it was DELIVERED
 * into someone else's conversation. An agent's own replies in its own
 * conversation carry nothing, so without this they fall back to the main
 * assistant's face — the steward answering under Hermes's name and avatar.
 */
export function agentIdentityForProfile(
  jobs: CronJob[] | undefined,
  profile: string
): null | { avatar: string; label: string } {
  const wanted = profile.trim()

  if (!wanted || wanted === 'default') {
    return null
  }

  for (const job of jobs ?? []) {
    if (str(job, 'agent_profile') !== wanted) {
      continue
    }

    const label = str(job, 'agent_label')

    if (label) {
      return { avatar: str(job, 'agent_avatar'), label }
    }
  }

  return null
}
