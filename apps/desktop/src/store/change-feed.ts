/** Per-profile change-feed watermarks, persisted across restarts.

 * A watermark is only valid while `generation` matches the serving database's
 * (a restored backup swaps it); on mismatch the consumer drops it and falls
 * back to a full pull, which re-seeds from the next sessions.changed payload.
 */
import { atom } from 'nanostores'

const STORAGE_KEY = 'hermes:change-feed:v1'

export interface ChangeWatermark {
  generation: string
  seq: number
}

type Watermarks = Record<string, ChangeWatermark>

function load(): Watermarks {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')

    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const $changeWatermarks = atom<Watermarks>(load())

export function changeWatermark(profile: string): ChangeWatermark | null {
  return $changeWatermarks.get()[profile] ?? null
}

export function setChangeWatermark(profile: string, generation: string, seq: number): void {
  const next = { ...$changeWatermarks.get(), [profile]: { generation, seq } }

  $changeWatermarks.set(next)

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode / quota: watermarks degrade to in-memory for this session.
  }
}

export function dropChangeWatermark(profile: string): void {
  const { [profile]: _drop, ...next } = $changeWatermarks.get()

  $changeWatermarks.set(next)

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // See setChangeWatermark.
  }
}
