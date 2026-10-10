import {
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
  useMessagePartReasoning
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, type FC, type ReactNode, useEffect, useRef, useState } from 'react'

import { ClarifyTool } from '@/components/assistant-ui/clarify-tool'
import { MarkdownText, MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { DelegateTool } from '@/components/assistant-ui/tool/delegate'
import { ToolFallback, ToolGroupSlot } from '@/components/assistant-ui/tool/fallback'
import { formatElapsed, useElapsedSeconds, useMeasuredDuration } from '@/components/chat/activity-timer'
import { ActivityTimerText, TurnStreamStatsText } from '@/components/chat/activity-timer-text'
import { GeneratedImage } from '@/components/chat/generated-image-result'
import { SCAFFOLD_LABEL_CLASS, SCAFFOLD_META_CLASS, ScaffoldRow } from '@/components/chat/scaffold-row'
import { useI18n } from '@/i18n'
import { generatedImageFromResult } from '@/lib/generated-images'
import { separateGluedReasoningBlocks } from '@/lib/reasoning-blocks'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $reviewActivity } from '@/store/session'

const ImageGenerateTool: FC<ToolCallMessagePartProps> = props => {
  const { args, result } = props
  const aspectRatio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : undefined

  // The image card owns successful generations. Failed or malformed results
  // still need the normal tool row: it extracts the error text and gives the
  // user an honest, expandable failure rather than silently dropping the call.
  if (result !== undefined && !generatedImageFromResult(result)) {
    return <ToolFallback {...props} />
  }

  return (
    <div className="mt-1.5">
      <GeneratedImage aspectRatio={aspectRatio} result={result} />
    </div>
  )
}

const DelegateToolPart: FC<ToolCallMessagePartProps> = props => {
  // A call that failed outright dispatched nothing — there are no children to
  // list, only an error. The generic row extracts and expands it properly.
  if (props.isError) {
    return <ToolFallback {...props} />
  }

  return <DelegateTool args={props.args} result={props.result} toolCallId={props.toolCallId} />
}

const ChainToolFallback: FC<ToolCallMessagePartProps> = props => {
  // todo parts are hoisted to a dedicated panel above the message content.
  if (props.toolName === 'todo') {
    return null
  }

  // A reaction's UI is the emoji landing on the bubble (message.reaction
  // event) — a "React To Message" tool block next to it would be the agent
  // narrating its own tapback. Failures still render so they're debuggable.
  if (props.toolName === 'react_to_message' && !props.isError) {
    return null
  }

  if (props.toolName === 'delegate_task') {
    return <DelegateToolPart {...props} />
  }

  if (props.toolName === 'image_generate') {
    return <ImageGenerateTool {...props} />
  }

  if (props.toolName === 'clarify') {
    return <ClarifyTool {...props} />
  }

  return <ToolFallback {...props} />
}

// Per-timerKey disclosure memory: survives transcript replacements (0.5s
// adopted-turn refreshes remount parts) so a thinking block the user opened
// — or one auto-opened while streaming — does not visibly collapse/reopen
// in a loop. `openAt` powers a short sticky window that absorbs the refresh
// cadence; entries are tiny and capped defensively.
const thinkingDisclosureMemory = new Map<string, { userOpen: boolean | null; openAt: number }>()
const THINKING_STICKY_OPEN_MS = 2000

const ThinkingDisclosure: FC<{
  children: ReactNode
  messageRunning?: boolean
  pending?: boolean
  // Required: the block's duration is remembered against this key, so a
  // component that mounts after the block finished can still report it.
  timerKey: string
}> = ({ children, messageRunning = false, pending = false, timerKey }) => {
  const { t } = useI18n()
  // `null` = no explicit user toggle yet, defer to the streaming default.
  // The default is "auto-open while streaming, auto-collapse when done" so
  // reasoning surfaces a live preview without manual interaction. The first
  // explicit toggle wins from then on.
  // The memory + sticky window survive transcript REPLACEMENTS: the 0.5s
  // adopted-turn refresh remounts every message part, which reset this
  // local state to null and let the flapping `pending` signal collapse and
  // re-expand the block in a visible loop (the 2026-09-19 flicker).
  const [userOpen, setUserOpenState] = useState<boolean | null>(
    () => thinkingDisclosureMemory.get(timerKey)?.userOpen ?? null
  )
  const elapsed = useElapsedSeconds(pending, timerKey)
  const thoughtFor = useMeasuredDuration(pending, timerKey)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const enterRef = useEnterAnimation(messageRunning, timerKey)

  const stickyOpen =
    Date.now() - (thinkingDisclosureMemory.get(timerKey)?.openAt ?? 0) <
    THINKING_STICKY_OPEN_MS
  const open = (userOpen ?? pending) || stickyOpen
  const isPreview = pending && userOpen === null

  useEffect(() => {
    if (open) {
      const prev = thinkingDisclosureMemory.get(timerKey)
      thinkingDisclosureMemory.set(timerKey, {
        userOpen: prev?.userOpen ?? null,
        openAt: Date.now(),
      })
    }
  })

  const setUserOpen = (value: boolean) => {
    setUserOpenState(value)
    const prev = thinkingDisclosureMemory.get(timerKey)
    thinkingDisclosureMemory.set(timerKey, { userOpen: value, openAt: prev?.openAt ?? 0 })
  }

  // Three ways a finished block can report itself. With a measured duration it
  // says so, unless the timer's whole seconds round it to "0s" — accurate and
  // useless — in which case it just says it was quick. With no duration at all
  // it still has to read as finished; a turn that ended must not go on saying
  // "Thinking".
  let thoughtLabel = t.assistant.thread.thinking

  if (!pending) {
    if (thoughtFor === null) {
      thoughtLabel = t.assistant.thread.thought
    } else if (thoughtFor < 1) {
      thoughtLabel = t.assistant.thread.thoughtBriefly
    } else {
      thoughtLabel = t.assistant.thread.thoughtFor(formatElapsed(thoughtFor))
    }
  }

  // While the preview is live, pin the scroll container to the bottom on
  // every content growth so the latest tokens are always visible.
  useEffect(() => {
    if (!isPreview) {
      return
    }

    const el = scrollRef.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    // Height-gated: the observer also fires when the container's WIDTH changes
    // (sidebar sash drag resizes every message), and pinning there forces a
    // scrollHeight read+write per preview per frame. Only actual content
    // growth needs the pin; the height rides the RO entry, reflow-free.
    let lastHeight = -1

    const pin = (entries: readonly ResizeObserverEntry[]) => {
      const height = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize ?? -1
      const grew = height < 0 || height > lastHeight
      lastHeight = height

      if (grew) {
        el.scrollTop = el.scrollHeight
      }
    }

    // No sync pin(): the observer's guaranteed initial delivery runs it with
    // layout already clean (still before paint), avoiding a forced reflow.
    const observer = new ResizeObserver(pin)
    observer.observe(content)

    return () => observer.disconnect()
    // Re-run when the disclosure toggles so the observer attaches to the new
    // DOM after expand/collapse (refs are conditionally rendered on `open`).
  }, [isPreview, open])

  return (
    <div
      className="text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
      data-conversation-scaffold=""
      data-slot="aui_thinking-disclosure"
      ref={enterRef}
    >
      <ScaffoldRow onToggle={() => setUserOpen(!open)} open={open}>
        <span className={cn(SCAFFOLD_LABEL_CLASS, pending && 'shimmer')}>{thoughtLabel}</span>
        {pending && <ActivityTimerText className={SCAFFOLD_META_CLASS} seconds={elapsed} />}
        {pending && <TurnStreamStatsText className={SCAFFOLD_META_CLASS} />}
      </ScaffoldRow>
      {open && (
        <div
          className={cn(
            // Body sits flush with the "Thinking" header — no left indent —
            // and inherits the disclosure-level opacity fade defined in
            // styles.css (~0.67 at rest, 1 on hover/focus).
            'mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1',
            isPreview && 'max-h-40'
          )}
          ref={scrollRef}
        >
          <div ref={contentRef}>{children}</div>
        </div>
      )}
    </div>
  )
}

// Self-gate "Thinking…" on this message's own reasoning parts. Reading
// `thread.isRunning` directly would flicker shimmer/timer on every old
// assistant whenever the external-store runtime clears+reimports its
// repository (one ref-identity bump per streaming delta).
const ReasoningAccordionGroup: FC<{ children?: ReactNode; endIndex: number; startIndex: number }> = ({
  children,
  endIndex,
  startIndex
}) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  const pending = useAuiState(
    s =>
      s.thread.isRunning &&
      s.message.status?.type === 'running' &&
      s.message.parts
        .slice(Math.max(0, startIndex), endIndex + 1)
        .some(p => p?.type === 'reasoning' && p.status?.type !== 'complete')
  )

  // A reasoning group with no actual text is pure noise — drop the whole
  // "Thinking" disclosure rather than leave an empty header eating a row. This
  // applies live too: encrypted/spinner-coerced reasoning (Opus reasoning max)
  // never carries visible text, and the bottom-of-thread loader already signals
  // "thinking", so an empty header is never wanted. Real reasoning surfaces the
  // instant its first token lands.
  const hasContent = useAuiState(s =>
    s.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .some(p => p?.type === 'reasoning' && typeof p.text === 'string' && p.text.trim().length > 0)
  )

  if (!hasContent) {
    return null
  }

  return (
    // Keyed per block, not per message: the timer registry hands every caller
    // of a key the same origin, so a turn that thinks three separate times used
    // to measure the second and third blocks from the first one's start and
    // report the running total as each block's duration.
    // timerKey 不依赖 startIndex（2026-09-22 杨航报"思考框反复折叠展开"）：
    // reasoning.available / moa.reference / moa.progress 等 replace=true 路径
    // 会让 reasoning part 数组的 index 偏移，老 timerKey 被 unmount、新 timerKey
    // mount，userOpen 被 reset 成 null、stickyOpen（基于 openAt 时间戳）也失效，
    // `open = (null ?? pending) || stickyOpen` 在 pending=false 时折叠。
    // 用 messageId 单独作 key 即可——同一 message 的所有 reasoning parts 共享
    // 一个 disclosure 状态；不同 message 用不同 id 自然隔离。
    <ThinkingDisclosure
      messageRunning={messageRunning}
      pending={pending}
      // AUTO-CONTINUE GHOST FIX (2026-10-10): when a turn is interrupted and
      // auto-continued, the SAME message carries TWO reasoning parts (original
      // + continuation). Sharing one timerKey made the second read the first's
      // accumulated timer/stats — a "ghost" Thinking with empty content but
      // the original's numbers. Discriminate by part index ONLY when there are
      // multiple reasoning parts (the single-part case keeps the stable key
      // from the timerKey flicker fix, 2026-09-22).
      // AUTO-CONTINUE GHOST FIX (2026-10-10): a turn interrupted + auto-
      // continued carries TWO reasoning groups in one message. Sharing one
      // timerKey made both read/write the same disclosure memory — the ghost
      // showed the original's stats with empty content, flickering as both
      // fought over one state. The FIRST group keeps the stable messageId-only
      // key (the 2026-09-22 flicker fix); groups AFTER the first add their
      // startIndex — auto-continue parts are appended at the END so their
      // index is stable (the shifting that motivated removing startIndex only
      // affected the first group via replace=true).
      timerKey={`reasoning:${messageId}${startIndex > 0 ? `:${startIndex}` : ''}`}
    >
      {children}
    </ThinkingDisclosure>
  )
}

// Read the part from context, same contract as MarkdownText's
// useMessagePartText — the reasoning-only smoothing wrapper (removed) stalled
// the char-reveal at empty, blanking the widget.
const ReasoningTextPart: ReasoningMessagePartComponent = () => {
  const { status, text } = useMessagePartReasoning()
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  return (
    <MarkdownTextContent
      containerClassName="text-xs leading-snug text-muted-foreground/85"
      containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
      disableArtifacts
      isRunning={status.type === 'running' || messageRunning}
      text={separateGluedReasoningBlocks(text.trimStart())}
    />
  )
}

// Module-level constant so the `components` prop on `MessagePrimitive.Parts`
// has a stable identity across renders. Without this every AssistantMessage
// render would create a fresh `components` object, invalidating the memo on
// `MessagePrimitivePartByIndex` and forcing every tool/reasoning child to
// re-render on every streaming delta. Memo invalidation alone doesn't
// remount, but combined with the previous ToolFallback group-swap it was a
// big chunk of the per-delta work.
export const MESSAGE_PARTS_COMPONENTS = {
  Reasoning: ReasoningTextPart,
  ReasoningGroup: ReasoningAccordionGroup,
  Text: MarkdownText,
  ToolGroup: ToolGroupSlot,
  tools: { Fallback: ChainToolFallback }
} as const
