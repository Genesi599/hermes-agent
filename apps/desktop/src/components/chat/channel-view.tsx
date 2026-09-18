import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { SpeakerChip } from '@/components/assistant-ui/thread/speaker-chip'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { type Channel, type ChannelMessage, fetchChannelMessages, postChannelMessage } from '@/lib/channels'
import { splitMediaRefs } from '@/lib/chat-messages'
import { mediaKind, mediaName, resolveMediaDisplaySrc } from '@/lib/media'
import { DEFAULT_AGENT_SPEAKER } from '@/lib/chat-identity'
import { cn } from '@/lib/utils'

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

export function ChannelView({ channel, className }: { channel: Channel; className?: string }) {
  const { t } = useI18n()
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setMessages(await fetchChannelMessages(channel.id))
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

    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [messages.length])

  const send = useCallback(async () => {
    const text = draft.trim()

    if (!text || sending) {
      return
    }

    setSending(true)

    try {
      const id = await postChannelMessage(channel.id, text)

      if (id !== null) {
        setDraft('')
        await load()
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setSending(false)
    }
  }, [channel.id, draft, load, sending])

  const lines = useMemo(() => messages, [messages])

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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-selectable-text="true" ref={scrollRef}>
        {lines.map(line => (
          <article className="mb-4" data-channel-author={line.author_label ?? ''} key={line.id}>
            <SpeakerChip
              avatar={line.author_avatar || (line.author_kind === 'human' ? '🧑' : undefined)}
              avatarImage={
                line.author_kind === 'human' || line.author_avatar ? undefined : DEFAULT_AGENT_SPEAKER.avatarImage
              }
              name={line.author_label || DEFAULT_AGENT_SPEAKER.name}
            />
            <div className="mt-1 text-foreground/90">
              {splitMediaRefs(line.content).map((segment, index) =>
                segment.kind === 'media' ? (
                  <ChannelMedia key={`media-${line.id}-${index}`} path={segment.path} />
                ) : (
                  <CompactMarkdown className="text-foreground/90" key={`text-${line.id}-${index}`} text={segment.text} />
                )
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="shrink-0 border-t border-(--ui-stroke-tertiary) p-3">
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
            placeholder={t.assistant.thread.channelPlaceholder}
            rows={1}
            value={draft}
          />
          <Button disabled={sending || !draft.trim()} onClick={() => void send()} size="sm" variant="outline">
            {t.assistant.thread.channelPost}
          </Button>
        </div>
      </div>
    </div>
  )
}
