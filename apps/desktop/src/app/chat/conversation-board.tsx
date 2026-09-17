import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { persistentAtom } from '@/lib/persisted'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $sessions, sessionMatchesStoredId } from '@/store/session'

/**
 * CONVERSATION BOARD — the conversation's shared blackboard, embedded in the
 * chat surface itself.
 *
 * A conversation IS its project, and the project's board lives at
 * `<user home>/hermes_board/<conversation title>/`: `state.md` is what is in
 * flight, `decisions.md` is what has been settled. Hermes maintains both.
 *
 * The board renders INSIDE the conversation, directly above the transcript —
 * not in the preview rail. It is the room the group chat is talking in, so it
 * has to read as one surface with the messages below it; a preview tab is a
 * second place to look and closes independently of the chat it belongs to.
 *
 * Resolution is by TITLE, not by session id: the board is a property of the
 * project, and the title is what names the project. A conversation with no
 * board directory renders NOTHING — no placeholder, no border — so an ordinary
 * chat pays only a failed stat, at a slow cadence that still picks up a board
 * created later (a project promoted to a shared conversation) without a reload.
 */

const BOARD_ROOT = 'hermes_board'

/** The two files worth a tab. `log.jsonl` is an append-only audit trail the
 *  chat transcript already shows as it happens, so it gets no tab of its own. */
const BOARD_FILES = ['state', 'decisions'] as const

type BoardFile = (typeof BOARD_FILES)[number]

/** Present + on screen: catch an agent's write within a beat. Present but
 *  collapsed or backgrounded, and absent: nothing to see, so read rarely —
 *  this is a file poll, and the file is small but the app is not always
 *  looking at it. */
const BOARD_POLL_MS = 5000
const BOARD_IDLE_POLL_MS = 30000

interface BoardContent {
  present: boolean
  text: string
}

const ABSENT: BoardContent = { present: false, text: '' }

/** Collapsed boards, by conversation title. Per title rather than global: a
 *  board that is noise in one project is the point of another. */
const $collapsedBoards = persistentAtom<Record<string, boolean>>('hermes.desktop.boardCollapsed.v1', {})

/** The Electron bridge is async but the home directory never changes, and the
 *  panel mounts per conversation switch — resolve it once per window. */
let homePromise: null | Promise<string> = null

function userHome(): Promise<string> {
  if (!homePromise) {
    const request = window.hermesDesktop?.userHome?.()

    // A bridge that answers nothing must not latch: clearing the cache lets
    // the next poll retry instead of hiding the board for the whole session.
    homePromise = request
      ? request.catch(() => {
          homePromise = null

          return ''
        })
      : Promise.resolve('')
  }

  return homePromise
}

async function readBoard(path: string): Promise<BoardContent> {
  try {
    const result = await readDesktopFileText(path)

    return typeof result?.text === 'string' ? { present: true, text: result.text } : ABSENT
  } catch {
    // Missing board (the common case), unreadable path, bridge down — all of
    // them mean "this conversation has no board to show".
    return ABSENT
  }
}

export interface ConversationBoardProps {
  className?: string
  storedSessionId: null | string
}

export function ConversationBoard({ className, storedSessionId }: ConversationBoardProps) {
  const { t } = useI18n()
  const copy = t.assistant.board

  // Scalar selector: the session list republishes on every status poll, and
  // this panel only cares which conversation is open.
  const title = useStoreSelector($sessions, sessions => {
    const row = storedSessionId ? sessions.find(session => sessionMatchesStoredId(session, storedSessionId)) : undefined

    // Not `sessionTitle()`: its "Untitled session" placeholder would be looked
    // up as a real directory name.
    return (row?.title || row?.preview || '').trim()
  })

  const collapsed = useStore($collapsedBoards)[title] ?? false
  const [file, setFile] = useState<BoardFile>('state')
  const [content, setContent] = useState<BoardContent>(ABSENT)

  useEffect(() => {
    if (!title) {
      setContent(ABSENT)

      return
    }

    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      const home = await userHome()

      if (!live) {
        return
      }

      const next = home ? await readBoard(`${home.replace(/[\\/]+$/, '')}/${BOARD_ROOT}/${title}/${file}.md`) : ABSENT

      if (!live) {
        return
      }

      // Same bytes → same state object, so React bails out and a board nobody
      // is editing costs no renders.
      setContent(prev => (prev.present === next.present && prev.text === next.text ? prev : next))

      const idle = collapsed || document.visibilityState === 'hidden'

      timer = setTimeout(() => void poll(), next.present && !idle ? BOARD_POLL_MS : BOARD_IDLE_POLL_MS)
    }

    void poll()

    return () => {
      live = false

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [collapsed, file, title])

  if (!title || !content.present) {
    return null
  }

  const toggle = () => $collapsedBoards.set({ ...$collapsedBoards.get(), [title]: !collapsed })

  return (
    <section
      className={cn(
        'mx-3 mt-2 shrink-0 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-card/60 shadow-sm',
        className
      )}
      data-slot="conversation-board"
    >
      <div className="flex h-8 items-center gap-1 px-2">
        <button
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
          onClick={toggle}
          title={collapsed ? copy.expand : copy.collapse}
          type="button"
        >
          <Codicon
            className="shrink-0 text-(--ui-text-quaternary)"
            name={collapsed ? 'chevron-right' : 'chevron-down'}
            size="0.75rem"
          />
          <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="project" size="0.75rem" />
          <span className="shrink-0 text-[0.72rem] font-medium text-foreground">{copy.title}</span>
          <span className="truncate text-[0.72rem] text-muted-foreground">{title}</span>
        </button>

        <div className="ml-1 flex shrink-0 items-center gap-0.5" role="tablist">
          {BOARD_FILES.map(key => (
            <button
              aria-selected={file === key}
              className={cn(
                'rounded px-1.5 py-0.5 text-[0.68rem] transition-colors',
                file === key
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
              key={key}
              onClick={() => setFile(key)}
              role="tab"
              type="button"
            >
              {copy[key]}
            </button>
          ))}
        </div>

        <Tip label={copy.owner}>
          <span className="ml-auto shrink-0 pr-1 text-[0.62rem] uppercase tracking-[0.08em] text-(--ui-text-quaternary)">
            {copy.owner}
          </span>
        </Tip>
      </div>

      {!collapsed && (
        <div
          className="max-h-[34vh] overflow-auto border-t border-(--ui-stroke-tertiary) px-3 py-2"
          data-selectable-text="true"
        >
          {content.text.trim() ? (
            <CompactMarkdown className="text-foreground/90" text={content.text} />
          ) : (
            <p className="text-[0.7rem] italic text-muted-foreground">{copy.empty}</p>
          )}
        </div>
      )}
    </section>
  )
}
