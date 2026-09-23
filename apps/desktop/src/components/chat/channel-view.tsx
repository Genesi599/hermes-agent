import { type ClipboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'

import { SpeakerChip } from '@/components/assistant-ui/thread/speaker-chip'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { RoomModelSelect } from '@/components/chat/room-model-select'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { type Channel, type ChannelMessage, fetchChannelMessages, postChannelMessage } from '@/lib/channels'
import { DEFAULT_AGENT_SPEAKER, USER_SPEAKER } from '@/lib/chat-identity'
import { splitMediaRefs } from '@/lib/chat-messages'
import { blobExtension, mediaKind, mediaName, resolveMediaDisplaySrc } from '@/lib/media'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { onScrollToBottomRequest, requestScrollToBottom, resetThreadScroll, setThreadAtBottom, $threadJumpButtonVisible } from '@/store/thread-scroll'

/**
 * CHANNEL VIEW — the room itself.
 *
 * Reads a channel's lines and posts new human ones. No thread, no runtime, no
 * model: a channel is a place, and posting a line is an insert (the backend
 * records it and nudges the routing watchdog, which is where Hermes decides who
 * the message concerns). Every line says who spoke — agents arrive with their
 * own `author_label`/`author_avatar`, the human with their own chip — which is
 * what makes the room readable as an exchange rather than as a conversation
 * with one assistant.
 */
/** One MEDIA: reference, rendered INLINE like the thread renders it — the raw
 *  path is not loadable in the renderer, so resolve it through the desktop
 *  bridge (data URL) and reuse the thread's image chrome (zoom / download).
 *  Non-image media keeps a name line: the room is text-first. */
function ChannelMedia({ path }: { path: string }) {
  const kind = mediaKind(path)
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true

    setSrc('')
    setFailed(false)

    void resolveMediaDisplaySrc(path)
      .then(value => {
        if (live) {
          setSrc(value)
        }
      })
      .catch(() => {
        if (live) {
          setFailed(true)
        }
      })

    return () => {
      live = false
    }
  }, [path])

  if (kind !== 'image') {
    return (
      <div className="my-1 text-[0.75rem] text-(--ui-text-tertiary)">
        {kind === 'video' ? '🎬' : '🎵'} {mediaName(path)}
      </div>
    )
  }

  if (failed) {
    return <div className="my-1 text-[0.75rem] text-(--ui-text-tertiary)">Couldn&rsquo;t load {mediaName(path)}</div>
  }

  if (!src) {
    return <div className="my-1 text-[0.75rem] text-(--ui-text-tertiary)">Loading {mediaName(path)}…</div>
  }

  return (
    <ZoomableImage
      alt={mediaName(path)}
      className="m-0 block h-auto w-auto max-h-64 max-w-full rounded-lg object-contain"
      containerClassName="my-1.5 block w-fit max-w-[min(100%,28rem)]"
      src={src}
    />
  )
}

/** One room line. MEMOIZED with its own parse: `splitMediaRefs` runs two
 *  regexes over the line's whole content, and a busy room holds up to 200 lines
 *  — recomputing all of them on every keystroke (the draft used to live one
 *  level up) and on every re-render above the list was the room's typing lag
 *  (2026-09-18). `line` is stable per fetch, so a memoized line only renders
 *  when the room actually gained something. */
const ChannelLine = memo(function ChannelLine({ line }: { line: ChannelMessage }) {
  const segments = useMemo(() => splitMediaRefs(line.content), [line.content])

  return (
    <article className="mb-4" data-channel-author={line.author_label ?? ''}>
      <SpeakerChip
        avatar={line.author_avatar || undefined}
        avatarImage={
          line.author_avatar
            ? undefined
            : line.author_kind === 'human'
              ? USER_SPEAKER.avatarImage
              : DEFAULT_AGENT_SPEAKER.avatarImage
        }
        name={line.author_label || (line.author_kind === 'human' ? USER_SPEAKER.name : DEFAULT_AGENT_SPEAKER.name)}
      />
      <div className="mt-1 text-foreground/90">
        {segments.map((segment, index) =>
          segment.kind === 'media' ? (
            <ChannelMedia key={`media-${index}`} path={segment.path} />
          ) : (
            <CompactMarkdown className="text-foreground/90" key={`text-${index}`} text={segment.text} />
          )
        )}
      </div>
    </article>
  )
})

/** The `MEDIA: <path>` form of an image path — the one syntax the room renders
 *  inline (`splitMediaRefs`) and the one an agent can open as a file. Quoted
 *  when the path has spaces: the parser accepts both shapes. */
function mediaRefLine(path: string): string {
  const value = /\s/.test(path) ? `"${path}"` : path

  return `MEDIA: ${value}`
}

/** The poll hands back a fresh array of fresh objects every time. Keep the
 *  objects React already rendered for lines that did NOT change, so a poll that
 *  brought one new line re-renders one line instead of the whole room (each
 *  line's render re-parses its text for MEDIA refs), and hand back the CURRENT
 *  array when nothing is new so React bails out of the update entirely. */
function mergeMessages(current: ChannelMessage[], next: ChannelMessage[]): ChannelMessage[] {
  if (current.length === 0) {
    return next
  }

  const previous = new Map(current.map(message => [message.id, message]))
  let changed = current.length !== next.length

  const merged = next.map(message => {
    const before = previous.get(message.id)

    if (before && before.content === message.content) {
      return before
    }

    changed = true

    return message
  })

  return changed ? merged : current
}

/** The room's composer. The DRAFT LIVES HERE, not in ChannelView: while it was
 *  one level up, every keystroke re-rendered the whole room (200 lines of
 *  markdown + a full MEDIA re-parse) — the typing lag this fixes. */
function ChannelComposer({
  channelId,
  onPosted,
  project
}: {
  channelId: string
  onPosted: () => void
  project: string
}) {
  const { t } = useI18n()
  const d = t.desktop
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const insertMediaRef = useCallback((path: string) => {
    const node = inputRef.current
    const value = node?.value ?? ''
    const start = node?.selectionStart ?? value.length
    const end = node?.selectionEnd ?? value.length
    const lead = start === 0 || value[start - 1] === '\n' ? '' : '\n'
    const token = `${lead}${mediaRefLine(path)}\n`

    setDraft(`${value.slice(0, start)}${token}${value.slice(end)}`)

    // Caret after the inserted ref and the box still focused — what gets typed
    // next is prose, not a continuation of the path.
    requestAnimationFrame(() => {
      node?.focus()
      node?.setSelectionRange(start + token.length, start + token.length)
    })
  }, [])

  const saveImages = useCallback(
    async (files: File[]) => {
      const bridge = window.hermesDesktop

      if (!bridge) {
        return
      }

      for (const file of files) {
        try {
          const data = new Uint8Array(await file.arrayBuffer())
          const path = await bridge.saveImageBuffer(data, blobExtension(file))

          if (path) {
            insertMediaRef(path)
          }
        } catch (err) {
          notifyError(err, d.imageAttachFailed)
        }
      }
    },
    [d.imageAttachFailed, insertMediaRef]
  )

  const saveClipboardImage = useCallback(async () => {
    const bridge = window.hermesDesktop

    if (!bridge) {
      return
    }

    try {
      const path = await bridge.saveClipboardImage()

      // Nothing on the clipboard: stay SILENT, like the thread composer — a
      // paste that was never an image should not raise a warning.
      if (path) {
        insertMediaRef(path)
      }
    } catch (err) {
      notifyError(err, d.clipboardPasteFailed)
    }
  }, [d.clipboardPasteFailed, insertMediaRef])

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    const images = Array.from(data?.files ?? []).filter(file => file.type.startsWith('image/'))

    if (images.length > 0) {
      event.preventDefault()
      void saveImages(images)

      return
    }

    // A copied screenshot can reach the renderer with neither text nor files
    // (Chromium never hands the bitmap over) — ask the main process for the OS
    // clipboard image, the same fallback the thread composer uses. Pasting
    // TEXT keeps its default behaviour.
    const hasText = Boolean(data?.getData('text/plain') || data?.getData('text'))

    if (!hasText && !(data?.files?.length ?? 0)) {
      event.preventDefault()
      void saveClipboardImage()
    }
  }

  const send = useCallback(async () => {
    const text = draft.trim()

    if (!text || sending) {
      return
    }

    setSending(true)

    try {
      const id = await postChannelMessage(channelId, text)

      if (id !== null) {
        setDraft('')
        onPosted()
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setSending(false)
    }
  }, [channelId, draft, onPosted, sending])

  return (
    <>
      {error ? <p className="mb-2 text-[0.6875rem] text-red-500">{error}</p> : null}
      <div className="flex items-end gap-2">
        <textarea
          className="min-h-9 max-h-32 min-w-0 flex-1 resize-none rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 py-1.5 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)"
          data-slot="channel-composer"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          onPaste={handlePaste}
          placeholder={t.assistant.thread.channelPlaceholder}
          ref={inputRef}
          rows={1}
          value={draft}
        />
        <Button disabled={sending || !draft.trim()} onClick={() => void send()} size="sm" variant="outline">
          {t.assistant.thread.channelPost}
        </Button>
        <RoomModelSelect channelId={channelId} project={project} />
      </div>
    </>
  )
}

function ChannelViewImpl({ channel, className }: { channel: Channel; className?: string }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [error, setError] = useState<null | string>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Sticky-bottom for the room: the user is "at the bottom" until they scroll
  // meaningfully up. Mirrors what the private thread's use-stick-to-bottom
  // does for its own list — this component feeds the same store so the
  // floating jump control (below) lights up with identical semantics.
  const atBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const node = scrollRef.current

    if (!node) {
      return
    }

    const isAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80

    atBottomRef.current = isAtBottom
    setThreadAtBottom(isAtBottom)
  }, [])

  const jumpVisible = useStore($threadJumpButtonVisible)

  const load = useCallback(async () => {
    try {
      const next = await fetchChannelMessages(channel.id)

      // A room only ever GAINS lines (posting is an insert) — merging keeps
      // every unchanged line's identity, which is what makes the poll cheap.
      setMessages(current => mergeMessages(current, next))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [channel.id])

  useEffect(() => {
    void load()

    // The room moves when anyone speaks (agents post through their delivery
    // path, which never touches this component), so read it on a light poll —
    // the same cadence the agent chips use for status.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void load()
      }
    }, 5000)

    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    const node = scrollRef.current

    // STICKY BOTTOM (2026-09-23): follow new lines ONLY while the user is
    // already at the bottom. The old unconditional jump yanked the viewport
    // down every time anyone posted — reading room history was impossible
    // while agents were delivering. When the user has scrolled up, leave the
    // viewport alone; the floating jump button is the way back down.
    if (node && atBottomRef.current) {
      node.scrollTop = node.scrollHeight
    }
  }, [messages.length])

  // Bridge to the shared jump control: the room and the private thread are
  // rendered exclusively (`room ? <ChannelView/> : <Thread/>`), so reusing
  // the thread-scroll store/handlers is safe — only one scroller registers
  // at a time.
  useEffect(() => {
    const off = onScrollToBottomRequest(() => {
      const node = scrollRef.current

      if (node) {
        atBottomRef.current = true
        node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
        setThreadAtBottom(true)
      }
    })

    return () => {
      off()
      resetThreadScroll()
    }
  }, [])

  const reload = useCallback(() => {
    void load()
  }, [load])

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-(--ui-chat-surface-background)', className)}
      data-slot="channel-view"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3">
        <span className="text-[0.6875rem] font-semibold text-(--ui-text-secondary)">{channel.title}</span>
        <span className="text-[0.625rem] text-(--ui-text-quaternary)">
          {t.assistant.thread.channelSubtitle(channel.message_count)}
        </span>
      </div>

      {/* Relative wrapper so the floating jump control positions against the
          viewport, not the scrolling content (an absolute child INSIDE the
          scroller would ride along with the messages). */}
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto px-4 py-3" data-selectable-text="true" onScroll={handleScroll} ref={scrollRef}>
          {messages.map(line => (
            <ChannelLine key={line.id} line={line} />
          ))}
        </div>
        {jumpVisible ? (
          <button
            aria-label={t.assistant.thread.scrollToBottom}
            className="thread-jump-button absolute left-1/2 bottom-4 z-20 grid size-8 place-items-center rounded-full border border-border/65 bg-(--composer-fill) text-muted-foreground backdrop-blur-[0.75rem] [-webkit-backdrop-filter:blur(0.75rem)] hover:text-foreground"
            data-state="in"
            onClick={() => {
              triggerHaptic('selection')
              requestScrollToBottom()
            }}
            type="button"
          >
            <Codicon name="arrow-down" size="1rem" />
          </button>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-(--ui-stroke-tertiary) p-3">
        {error ? <p className="mb-2 text-[0.6875rem] text-red-500">{error}</p> : null}
        <ChannelComposer channelId={channel.id} onPosted={reload} project={channel.project} />
      </div>
    </div>
  )
}

/** Parent re-renders (the chat surface subscribes to a lot) must not cascade
 *  into the room; `channel` is state held by the parent, so its identity is
 *  stable between polls. */
export const ChannelView = memo(ChannelViewImpl)
