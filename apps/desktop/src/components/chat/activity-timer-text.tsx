import { useStore } from '@nanostores/react'

import { cn } from '@/lib/utils'
import { estimateStreamTokens, $turnStreamStats } from '@/store/turn-stream-stats'

import { formatElapsed } from './activity-timer'

interface ActivityTimerTextProps {
  seconds: number
  className?: string
}

export function ActivityTimerText({ seconds, className }: ActivityTimerTextProps) {
  return (
    // tabular-nums keeps the ticking digits monospaced (no jiggle) without the
    // fixed w-[1ch] boxes StableText used — those overflowed and overlapped the
    // neighbouring "Running …" status label in narrow chat rows (2026-08-10).
    <span
      className={cn(
        // Tinted with --dt-midground (very low alpha) so the timer reads
        // as part of the same "live signal" cluster as the dither block /
        // arc-border / working-session dot, instead of being neutral chrome.
        'shrink-0 text-[0.56rem] leading-none tracking-[0.02em] tabular-nums text-midground/55',
        className
      )}
    >
      {formatElapsed(seconds)}
    </span>
  )
}

/** `≈N tokens · M t/s` beside the elapsed timer — the Reasonix-style output
 * readout (2026-09-28). Tokens are estimated from streamed text length (the
 * real usage only arrives at turn end); the rate's denominator is burst time
 * (deltas actively flowing), not wall clock, so tool turns don't drag it.
 * Hidden until there is enough streamed text for the estimate to mean
 * anything. */
export function TurnStreamStatsText({ className }: { className?: string }) {
  const stats = useStore($turnStreamStats)

  if (stats.chars < 40) {
    return null
  }

  const tokens = estimateStreamTokens(stats)
  const seconds = stats.activeMs / 1000
  const rate = seconds >= 0.5 ? Math.round(tokens / seconds) : null

  return (
    <span
      className={cn(
        'shrink-0 text-[0.56rem] leading-none tracking-[0.02em] tabular-nums text-midground/55',
        className
      )}
    >
      ≈{tokens} tokens{rate !== null ? ` · ${rate} t/s` : ''}
    </span>
  )
}

