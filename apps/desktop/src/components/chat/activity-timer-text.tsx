import { cn } from '@/lib/utils'

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
