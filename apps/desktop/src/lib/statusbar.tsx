import { useEffect, useState } from 'react'

import { StableText } from '@/components/chat/stable-text'
import { compactNumber } from '@/lib/format'
import type { UsageStats } from '@/types/hermes'

export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const ss = String(seconds).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}

export function compactPath(path: string, max = 44): string {
  const trimmed = path.trim()

  if (trimmed.length <= max) {
    return trimmed
  }

  const segments = trimmed.split('/').filter(Boolean)

  if (segments.length < 2) {
    return `…${trimmed.slice(-(max - 1))}`
  }

  const tail = segments.slice(-2).join('/')

  return tail.length + 2 >= max ? `…${tail.slice(-(max - 1))}` : `…/${tail}`
}

export function contextBar(percent: number | undefined, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent ?? 0))
  const filled = Math.round((bounded / 100) * width)

  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export function usageContextLabel(usage: UsageStats): string {
  if (usage.context_max) {
    const base = `${compactNumber(usage.context_used ?? 0)}/${compactNumber(usage.context_max)}`

    if (usage.cache_read) {
      const hitRate = usage.prompt ? Math.round((usage.cache_read / usage.prompt) * 100) : null

      return hitRate
        ? `${base} \u00b7 cache ${compactNumber(usage.cache_read)} (${hitRate}%)`
        : `${base} \u00b7 cache ${compactNumber(usage.cache_read)}`
    }

    return base
  }

  return usage.total > 0 ? `${compactNumber(usage.total)} tok` : ''
}

export function contextBarLabel(usage: UsageStats): string {
  if (!usage.context_max) {
    return ''
  }

  const pct = Math.max(0, Math.min(100, Math.round(usage.context_percent ?? 0)))

  return `[${contextBar(usage.context_percent)}] ${pct}%`
}

export function LiveDuration({ since }: { since: number | null | undefined }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!since) {
      return
    }

    const tick = () => setNow(Date.now())
    tick()
    const timer = window.setInterval(tick, 1000)

    return () => window.clearInterval(timer)
  }, [since])

  if (!since) {
    return null
  }

  // tabular-nums keeps the digits monospaced so the ticking timer doesn't
  // jiggle — same stability as the previous per-char StableText hack, without
  // the fixed w-[1ch] boxes that overflow/overlap in narrow status bars
  // (2026-08-10: "Running process" label collided with the seconds readout).
  return <span className="whitespace-nowrap tabular-nums">{formatDuration(now - since)}</span>
}
