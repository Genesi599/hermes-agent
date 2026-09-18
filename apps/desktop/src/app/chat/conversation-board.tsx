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
 * CONVERSATION BOARD — the conversation's shared blackboard, as a rail BESIDE
 * the chat.
 *
 * A conversation IS its project, and the project's board lives at
 * `<user home>/hermes_board/<conversation title>/`: `state.md` is what is in
 * flight, `decisions.md` is what has been settled. Hermes maintains both.
 *
 * The board is a PEER of the transcript, not a card inside it: a second column
 * on the right, full height of the chat area, separated by a border — the same
 * column the chat occupies, next to it. Two surfaces at one level, so reading
 * the room and reading the talk never fight over the same scroll. It is a
 * container query on the pane, NOT a primary-surface privilege: sessions open
 * as tiles, and a tile that is too narrow to hold a second column drops the
 * rail rather than crushing the transcript.
 *
 * Resolution is by TITLE, not by session id: the board is a property of the
 * project, and the title is what names the project. A ROOM (a conversation
 * with a bound channel — every conversation is its project's room now) always
 * renders its rail, even before the board files exist: the board is part of
 * the room's identity, and an absent file is the empty state, not the absence
 * of the column. A non-room conversation with no board directory still renders
 * NOTHING — no empty rail, no border — and pays only a failed stat at a slow
 * cadence that still picks up a board created later without a reload.
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
 *  rail mounts per conversation switch — resolve it once per window. */
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
  /** A room (conversation with a bound channel) always shows its board rail —
   *  an absent board file renders as the empty state, not as no column. */
  room?: boolean
  storedSessionId: null | string
}

export function ConversationBoard({ room = false, storedSessionId }: ConversationBoardProps) {
  const { t } = useI18n()
  const copy = t.assistant.board

  // Scalar selector: the session list republishes on every status poll, and
  // this rail only cares which conversation is open.
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

  if (!title || (!content.present && !room)) {
    return null
  }

  const toggle = () => $collapsedBoards.set({ ...$collapsedBoards.get(), [title]: !collapsed })

  if (collapsed) {
    return (
      <div
        className="hidden h-full w-9 shrink-0 flex-col items-center border-l border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) @4xl:flex"
        data-slot="conversation-board"
      >
        <button
          aria-label={copy.expand}
          className="mt-2 grid size-7 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)"
          onClick={toggle}
          title={copy.expand}
          type="button"
        >
          <Codicon name="project" size="0.875rem" />
        </button>
        <span
          className="mt-2 [writing-mode:vertical-rl] text-[0.625rem] font-semibold uppercase tracking-widest text-(--ui-text-tertiary)"
          style={{ transform: 'rotate(180deg)' }}
        >
          {copy.title}
        </span>
      </div>
    )
  }

  return (
    <aside
      className="hidden h-full w-80 shrink-0 flex-col overflow-hidden border-l border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) @4xl:flex"
      data-slot="conversation-board"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-tertiary) px-3">
        <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="project" size="0.875rem" />
        <span className="shrink-0 text-[0.6875rem] font-semibold text-(--ui-text-secondary)">{copy.title}</span>
        <span className="min-w-0 truncate text-[0.6875rem] text-(--ui-text-tertiary)">{title}</span>
        <Tip label={copy.collapse}>
          <button
            aria-label={copy.collapse}
            className="ml-auto grid size-6 shrink-0 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)"
            onClick={toggle}
            type="button"
          >
            <Codicon name="chevron-right" size="0.875rem" />
          </button>
        </Tip>
      </div>

      <div
        className="flex h-8 shrink-0 items-center gap-0.5 border-b border-(--ui-stroke-tertiary) px-2"
        role="tablist"
      >
        {BOARD_FILES.map(key => (
          <button
            aria-selected={file === key}
            className={cn(
              'rounded px-1.5 py-0.5 text-[0.6875rem] transition-colors',
              file === key
                ? 'bg-muted text-foreground'
                : 'text-(--ui-text-tertiary) hover:bg-(--ui-hover-overlay) hover:text-(--ui-text-secondary)'
            )}
            key={key}
            onClick={() => setFile(key)}
            role="tab"
            type="button"
          >
            {copy[key]}
          </button>
        ))}
        <span className="ml-auto shrink-0 pr-1 text-[0.625rem] uppercase tracking-[0.08em] text-(--ui-text-quaternary)">
          {copy.owner}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-selectable-text="true">
        {content.text.trim() ? (
          <CompactMarkdown text={content.text} />
        ) : (
          <p className="text-[0.75rem] italic text-(--ui-text-tertiary)">{copy.empty}</p>
        )}
      </div>
    </aside>
  )
}
