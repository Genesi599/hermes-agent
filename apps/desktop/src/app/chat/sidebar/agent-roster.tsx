import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { agentsForSession } from '@/lib/session-agents'
import { $cronJobs } from '@/store/cron'
import { ensureGatewayProfile } from '@/store/profile'

/**
 * Who is speaking in this conversation — the agents whose delivery jobs feed
 * into it, hung under the parent session row like branch children, but as
 * agents: each shows its own avatar + name, and clicking one switches into that
 * agent's profile so you can talk to it directly.
 *
 * The roster is derived from the delivery wiring (see `agentsForSession`), so
 * it needs no separate registry to keep in sync. Rows without agents render
 * nothing at all.
 */
function AgentRosterImpl({ sessionId }: { sessionId: string }) {
  const agents = agentsForSession(useStore($cronJobs), sessionId)

  if (!agents.length) {
    return null
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5 pl-8 pr-2"
      data-slot="sidebar-session-agents"
    >
      {agents.map(agent => (
        <button
          className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[0.625rem] leading-4 text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground"
          data-agent={agent.label}
          key={agent.label}
          onClick={event => {
            // The row underneath opens the SESSION; this opens the AGENT.
            event.preventDefault()
            event.stopPropagation()

            if (agent.profile) {
              void ensureGatewayProfile(agent.profile)
            }
          }}
          title={agent.profile ? `打开「${agent.label}」(${agent.profile})` : `${agent.label} 参与本对话`}
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
