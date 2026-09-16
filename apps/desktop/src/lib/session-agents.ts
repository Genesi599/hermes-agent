import type { CronJob } from '@/types/hermes'

/** One agent that speaks in a conversation. */
export interface SessionAgent {
  label: string
  avatar?: string
  /** The agent's Hermes profile — where its own conversation lives. */
  profile?: string
}

// `agent_label` / `agent_avatar` / `agent_profile` are emitted by the cron API
// for producer-labelled jobs but are not (yet) on the shared `CronJob` type,
// so read them structurally instead of widening a type this file does not own.
function str(source: unknown, key: string): string {
  if (!source || typeof source !== 'object') {
    return ''
  }

  const value = (source as Record<string, unknown>)[key]

  return typeof value === 'string' ? value.trim() : ''
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
    if (!job?.attach_to_session) {
      continue
    }

    if (str(job, 'target_session_id') !== target) {
      continue
    }

    const label = str(job, 'agent_label')

    if (!label || seen.has(label)) {
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
