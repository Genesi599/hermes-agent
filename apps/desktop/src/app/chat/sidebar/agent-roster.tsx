import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { listAllProfileSessions } from '@/hermes'
import { DEFAULT_AGENT_SPEAKER } from '@/lib/chat-identity'
import { agentsForSession } from '@/lib/session-agents'
import { $cronJobs } from '@/store/cron'
import { ensureGatewayProfile } from '@/store/profile'
import { $projectScope, ALL_PROJECTS, projectIdForCwd } from '@/store/projects'

/**
 * Who is speaking in this conversation — the agents whose delivery jobs feed
 * into it, hung under the parent session row, each with its own avatar + name.
 *
 * Clicking one opens a conversation WITH that agent (its newest session, or its
 * fresh context when it has none yet) — the same thing clicking a session row
 * does, so the gateway swap and tab wiring stay the app's own path. It does NOT
 * park you in the agent's profile: with the all-profiles view on, your own
 * sessions stay listed while the agent's chat opens beside them.
 *
 * The roster follows the delivery wiring (see `agentsForSession`), so there is
 * no second registry to keep in sync. Rows without agents render nothing.
 */
/**
 * The agent's conversation to open: its newest session IN THE CURRENT PROJECT
 * when the sidebar is scoped to one, else its newest session overall.
 *
 * A session's project is derived from where it ran (`git_repo_root`/`cwd`), the
 * same key the sidebar groups by — so this only finds project-scoped agent work
 * if the agent was actually dispatched with that project as its working dir.
 */
async function sessionToOpenForAgent(profile: string): Promise<null | string> {
  try {
    // A small page is enough: project-scoped agent work is recent by nature.
    const { sessions } = await listAllProfileSessions(20, 0, 'exclude', 'recent', profile)

    if (!sessions.length) {
      return null
    }

    const scope = $projectScope.get()

    if (scope && scope !== ALL_PROJECTS) {
      const inProject = sessions.find(session => {
        const where = (session.git_repo_root || session.cwd || '').trim()

        return Boolean(where) && projectIdForCwd(where) === scope
      })

      if (inProject) {
        return inProject.id
      }
    }

    return sessions[0].id
  } catch {
    return null
  }
}

function AgentRosterImpl({
  onOpenSession,
  sessionId
}: {
  /** Resume a session by id — the sidebar's own open path. */
  onOpenSession?: (sessionId: string) => void
  sessionId: string
}) {
  const agents = agentsForSession(useStore($cronJobs), sessionId)

  if (!agents.length) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5 pl-8 pr-2" data-slot="sidebar-session-agents">
      {/* The conversation's own agent: every session in the main profile is
          Hermes's, so it is a participant — shown first. Clicking it opens
          this conversation (the row it belongs to), same as the row itself. */}
      <button
        className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[0.625rem] leading-4 text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground"
        data-agent={DEFAULT_AGENT_SPEAKER.name}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          onOpenSession?.(sessionId)
        }}
        title={`打开与「${DEFAULT_AGENT_SPEAKER.name}」的对话`}
        type="button"
      >
        <span
          aria-hidden="true"
          className="inline-grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-full bg-(--ui-bg-tertiary) text-[0.5rem] leading-none"
        >
          <img alt="" className="size-full object-cover" src={DEFAULT_AGENT_SPEAKER.avatarImage} />
        </span>
        <span className="truncate">{DEFAULT_AGENT_SPEAKER.name}</span>
      </button>
      {agents.map(agent => (
        <button
          className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[0.625rem] leading-4 text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground"
          data-agent={agent.label}
          key={agent.label}
          onClick={async event => {
            // The row underneath opens the PARENT session; this opens the AGENT.
            event.preventDefault()
            event.stopPropagation()

            const profile = agent.profile

            if (!profile) {
              return
            }

            const target = await sessionToOpenForAgent(profile)

            if (target && onOpenSession) {
              onOpenSession(target)

              return
            }

            // No conversation yet — land in the agent's context so the next
            // message starts one.
            void ensureGatewayProfile(profile)
          }}
          title={`跟「${agent.label}」对话`}
          type="button"
        >
          <span
            aria-hidden="true"
            className="inline-grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-full bg-(--ui-bg-tertiary) text-[0.5rem] leading-none"
          >
            {agent.avatar ?? agent.label.charAt(0)}
          </span>
          <span className="truncate">{agent.label}</span>
        </button>
      ))}
    </div>
  )
}

export const AgentRoster = memo(AgentRosterImpl)
