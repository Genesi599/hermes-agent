import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { memo, useEffect, useState } from 'react'

import { openSession } from '@/app/open-session'
import { ActionsContextMenu, type MenuKit, renderActionItem } from '@/components/ui/actions-menu'
import { CopyButton } from '@/components/ui/copy-button'
import { listAllProfileSessions } from '@/hermes'
import { useI18n } from '@/i18n'
import { channelParticipants, roomBySession, type Channel } from '@/lib/channels'
import { DEFAULT_AGENT_SPEAKER } from '@/lib/chat-identity'
import { triggerHaptic } from '@/lib/haptics'
import { agentsForSession, type SessionAgent } from '@/lib/session-agents'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $agentActivity, $agentUnreadAt, agentWatchKey, type AgentWatch, markAgentRead, pollAgentWatch } from '@/store/agent-activity'
import { $cronJobs } from '@/store/cron'
import { notifyError } from '@/store/notifications'
import { ensureGatewayProfile } from '@/store/profile'
import { $projectScope, ALL_PROJECTS, projectIdForCwd } from '@/store/projects'
import { canOpenSessionWindow } from '@/store/windows'

import { sessionDotClassName } from '../session-status-dot'

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
 * A chip also answers to the right mouse button (2026-09-18): open its
 * conversation, send that conversation to a tab or a window, copy its id, clear
 * the unread dot. The set stays LEAN because a chip is not a session row — the
 * agent itself (SOUL, name, color, export) is managed on the profile rail,
 * which has its own right-click menu.
 *
 * The roster follows two truths (see `agentsForSession`): the delivery wiring,
 * and the room's own participant record. A ROOM (a session with a bound
 * channel) always renders — the maintainer's chip is the model itself: Hermes
 * keeps the group chat, the board and the agent cast for every project.
 * Non-room rows without delivery agents render nothing.
 */
/**
 * The agent's conversation to open: its newest session IN THE CURRENT PROJECT
 * when the sidebar is scoped to one, else its newest session overall.
 *
 * A session's project is derived from where it ran (`git_repo_root`/`cwd`), the
 * same key the sidebar groups by — so this only finds project-scoped agent work
 * if the agent was actually dispatched with that project as its working dir.
 */
async function sessionToOpenForAgent(profile: string, titlePrefix: string): Promise<null | string> {
  try {
    // MATCH BY NAME FIRST (`<项目> · <智能体>`, the convention the dispatch path
    // enforces). "Newest session" is not good enough: a wake or a dispatch that
    // did not get renamed leaves an auto-titled session behind, and the chip
    // then opened THAT stray instead of the agent's own conversation — which is
    // exactly the bug the user hit ("点管家和流程搭档跳转的对话不对").
    const { sessions } = await listAllProfileSessions(50, 0, 'exclude', 'recent', profile)
    const prefix = titlePrefix.trim()

    if (prefix) {
      // EXACT name first, then the prefix. The naming script appends a dedupe
      // counter when a title is taken (`星阶 · 流程搭档 (3)`), so a prefix match
      // alone can land on a stray instead of the agent's own conversation —
      // which is how the chip kept opening the wrong chat.
      const exact = sessions.find(session => (session.title || '').trim() === prefix)

      if (exact) {
        return exact.id
      }

      const named = sessions.find(session => (session.title || '').trim().startsWith(prefix))

      if (named) {
        return named.id
      }
    }

    if (!sessions.length) {
      return null
    }

    // No conversation of its own for this project yet: fall back to the newest
    // work in the project the sidebar is scoped to, else the newest at all.
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

/**
 * Hermes's OWN conversation in this project: `<conversation> · Hermes`.
 *
 * Hermes is a participant in the group chat but its thinking is not the group
 * chat — the user's rule: the conversation whose name is the project IS the
 * room everyone speaks in (and the board hangs off it), while Hermes's own
 * conversation is a separate one, named like every other agent's
 * (`<项目> · <名字>`). So its chip must land there, not on the row it sits
 * under. Returns null when Hermes has no such conversation yet.
 */
async function hermesConversationFor(title: string): Promise<null | string> {
  const name = (title || '').trim()

  if (!name) {
    return null
  }

  const prefix = `${name} · ${DEFAULT_AGENT_SPEAKER.name}`

  try {
    const { sessions } = await listAllProfileSessions(50, 0, 'exclude', 'recent', 'default')

    // Same rule as the agent chips: the exact name wins over a
    // `… (2)` dedupe sibling, so the chip never opens a stray.
    return (
      sessions.find(session => (session.title || '').trim() === prefix)?.id ??
      sessions.find(session => (session.title || '').trim().startsWith(prefix))?.id ??
      null
    )
  } catch {
    return null
  }
}

/** How often a chip re-reads its agent's status. A roster is a handful of
 *  chips on one row, and the underlying reads are tiny local queries — 10s is
 *  fast enough to watch a wake land without polling hard. */
const AGENT_POLL_MS = 10000

/** The status a chip paints: the avatar keeps its face, the state rides the
 *  same primitives a session row uses — the animated `arc-border` while the
 *  agent is producing, and the emerald `unread` dot when it finished while you
 *  were looking elsewhere (see `session-status-dot.tsx`: color says WHICH
 *  state, the arc says "something is happening"). */
function AgentChip({
  avatar,
  label,
  onOpen,
  profile,
  resolveTarget,
  title,
  watchKey
}: {
  avatar: React.ReactNode
  label: string
  /** Same as clicking the chip: open the agent's conversation, or land in its
   *  context when it has none yet. */
  onOpen: () => void
  profile: string
  /** The agent's conversation id, resolved the way a CLICK resolves it (exact
   *  `<项目> · <智能体>` name first). Asked for when the menu opens, not on
   *  every render — it is a lookup, not a subscription. */
  resolveTarget: () => Promise<null | string>
  title: string
  /** The activity-store key this chip reports on. Defaults to the profile;
   *  Hermes chips watch one conversation PER PROJECT inside the default
   *  profile, so they pass the composite key (see agentWatchKey). */
  watchKey?: string
}) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const key = watchKey ?? profile
  const status = useStoreSelector($agentActivity, activity => activity[key]?.status ?? 'idle')
  const unread = useStoreSelector($agentUnreadAt, marks => key in marks)
  const running = status === 'working'

  // What the right-click menu acts on. The roster's poll already published this
  // chip's conversation, so the common case needs no lookup; opening the menu
  // re-resolves anyway, because the poll follows a title PREFIX while a click
  // demands the exact name — the two disagree once the namer appended a
  // `… (2)` sibling (see sessionToOpenForAgent).
  const polledId = useStoreSelector($agentActivity, activity => activity[key]?.sessionId ?? null)
  const [lookedUpId, setLookedUpId] = useState<null | string>(null)
  const targetId = lookedUpId ?? polledId

  const lookUpTarget = () => {
    void resolveTarget().then(id => {
      if (id) {
        setLookedUpId(id)
      }
    })
  }

  const items = (kit: MenuKit) => (
    <>
      {renderActionItem(kit, {
        icon: 'comment-discussion',
        label: r.openConversation,
        onSelect: () => {
          triggerHaptic('selection')
          onOpen()
        }
      })}
      {renderActionItem(kit, {
        disabled: !targetId,
        icon: 'browser',
        label: r.openInNewTab,
        onSelect: () => {
          triggerHaptic('selection')

          if (targetId) {
            openSession(targetId, () => undefined, 'tab')
          }
        }
      })}
      {canOpenSessionWindow()
        ? [
            renderActionItem(kit, {
              disabled: !targetId,
              icon: 'link-external',
              label: r.newWindow,
              onSelect: () => {
                triggerHaptic('selection')

                if (targetId) {
                  openSession(targetId, () => undefined, 'window')
                }
              }
            })
          ]
        : []}
      <kit.Separator />
      <CopyButton
        appearance={kit.copyAppearance}
        disabled={!targetId}
        errorMessage={r.copyIdFailed}
        iconClassName="size-3.5 text-current"
        key={r.copyId}
        label={r.copyId}
        onCopyError={err => notifyError(err, r.copyIdFailed)}
        text={targetId ?? ''}
      />
      {unread
        ? [
            renderActionItem(kit, {
              icon: 'check',
              label: r.markRead,
              onSelect: () => {
                triggerHaptic('selection')
                markAgentRead(key)
              }
            })
          ]
        : []}
    </>
  )

  return (
    <ActionsContextMenu ariaLabel={r.agentActions} contentClassName="w-40" items={items}>
      <button
        className="relative flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[0.625rem] leading-4 text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground"
        data-agent={label}
        data-agent-state={running ? 'working' : unread ? 'unread' : 'idle'}
        onClick={event => {
          // The row underneath opens the PARENT session; this opens the AGENT.
          event.preventDefault()
          event.stopPropagation()
          onOpen()
        }}
        onContextMenu={lookUpTarget}
        title={running ? `${title} · ${r.sessionRunning}` : unread ? `${title} · ${r.finishedUnread}` : title}
        type="button"
      >
        {/* The arc is a CHILD span, never a class on the button: `.arc-border` is
            `position: absolute` (that is how the session row draws it), so putting
            it on the chip itself takes the chip out of flow and makes it vanish.
            Same primitive, same place — the chip's own box never moves. */}
        {running ? <span aria-hidden="true" className="arc-border arc-row arc-bottom" /> : null}
        <span className="relative inline-grid shrink-0 place-items-center">
          <span
            aria-hidden="true"
            className="inline-grid size-3.5 place-items-center overflow-hidden rounded-full bg-(--ui-bg-tertiary) text-[0.5rem] leading-none"
          >
            {avatar}
          </span>
          {unread && !running ? (
            <span
              aria-label={r.finishedUnread}
              className={cn(
                sessionDotClassName('unread'),
                'absolute -right-1 -top-1 ring-2 ring-(--ui-sidebar-surface-background)'
              )}
              data-slot="agent-unread-dot"
              role="status"
            />
          ) : null}
        </span>
        <span className="truncate">{label}</span>
      </button>
    </ActionsContextMenu>
  )
}

function AgentRosterImpl({
  onOpenSession,
  sessionId,
  sessionTitle
}: {
  /** Resume a session by id — the sidebar's own open path. */
  onOpenSession?: (sessionId: string) => void
  sessionId: string
  /** The row's own name — the project, and so the prefix of Hermes's own
   *  conversation (`星阶` → `星阶 · Hermes`). */
  sessionTitle?: string
}) {
  const jobs = useStore($cronJobs)
  const project = (sessionTitle ?? '').trim()

  // The room bound to this session is what makes the row a ROOM: its roster
  // carries the maintainer (Hermes) even before anyone else has spoken — that
  // is the model, not a special case. Polled lightly; `roomBySession` shares
  // one TTL-cached channel fetch across every roster on the sidebar.
  const [room, setRoom] = useState<Channel | null>(null)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const found = await roomBySession(sessionId)

      if (live) {
        setRoom(found)
        timer = setTimeout(() => void tick(), 30_000)
      }
    }

    void tick()

    return () => {
      live = false

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [sessionId])

  const agents = agentsForSession(jobs, sessionId, channelParticipants(room))

  // Who to watch: each agent's newest conversation, plus Hermes's own project
  // conversation (found by name, the same rule its chip opens by). Stable key
  // so the poller restarts only when the cast changes, not on every render.
  const watchKey = [project, ...agents.map(agent => agent.profile ?? '')].join('\u0000')

  const watch: AgentWatch[] = [
    { profile: 'default', titlePrefix: project ? `${project} · ${DEFAULT_AGENT_SPEAKER.name}` : undefined },
    ...agents.filter(agent => agent.profile).map(agent => ({ profile: agent.profile as string }))
  ]

  useEffect(() => {
    if (!project) {
      return
    }

    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const watches = watch

    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        for (const entry of watches) {
          if (!live) {
            return
          }

          await pollAgentWatch(entry)
        }
      }

      if (live) {
        timer = setTimeout(() => void tick(), AGENT_POLL_MS)
      }
    }

    void tick()

    return () => {
      live = false

      if (timer) {
        clearTimeout(timer)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- watchKey encodes the cast
  }, [watchKey, project])

  if (!agents.length && !room) {
    return null
  }

  const hermesWatchKey = agentWatchKey({
    profile: 'default',
    titlePrefix: project ? `${project} · ${DEFAULT_AGENT_SPEAKER.name}` : undefined
  })

  const openHermes = async () => {
    markAgentRead(hermesWatchKey)

    const target = await hermesConversationFor(project)

    onOpenSession?.(target ?? sessionId)
  }

  // The agent chips' two halves, so the click and the right-click menu land on
  // the SAME conversation: `resolveAgentTarget` only looks, `openAgent` also
  // goes there (the agent's own chat, or its bare context when it has none).
  const resolveAgentTarget = (agent: SessionAgent) =>
    agent.profile
      ? sessionToOpenForAgent(agent.profile, project && agent.label ? `${project} · ${agent.label}` : '')
      : Promise.resolve<null | string>(null)

  const openAgent = async (agent: SessionAgent) => {
    const profile = agent.profile

    if (!profile) {
      return
    }

    markAgentRead(profile)

    const target = await resolveAgentTarget(agent)

    if (target && onOpenSession) {
      onOpenSession(target)

      return
    }

    // No conversation yet — land in the agent's context so the next message
    // starts one.
    void ensureGatewayProfile(profile)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1.5 pl-8 pr-2" data-slot="sidebar-session-agents">
      {/* Hermes is a participant — shown first. Clicking it opens its OWN
          conversation for this project (`星阶 · Hermes`); only when it has none
          yet does it fall back to this row, which is where it speaks today. */}
      <AgentChip
        avatar={<img alt="" className="size-full object-cover" src={DEFAULT_AGENT_SPEAKER.avatarImage} />}
        label={DEFAULT_AGENT_SPEAKER.name}
        onOpen={() => void openHermes()}
        profile="default"
        resolveTarget={() => hermesConversationFor(project)}
        title={`打开与「${DEFAULT_AGENT_SPEAKER.name}」的对话（管理者：群聊/看板/智能体调度）`}
        watchKey={hermesWatchKey}
      />
      {agents.map(agent => (
        <AgentChip
          avatar={agent.avatar ?? agent.label.charAt(0)}
          key={agent.label}
          label={agent.label}
          onOpen={() => void openAgent(agent)}
          profile={agent.profile ?? agent.label}
          resolveTarget={() => resolveAgentTarget(agent)}
          title={`跟「${agent.label}」对话`}
        />
      ))}
    </div>
  )
}

export const AgentRoster = memo(AgentRosterImpl)
