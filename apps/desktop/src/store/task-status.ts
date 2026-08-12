import { persistentAtom } from '@/lib/persisted'

/**
 * Task-status sidebar (per-session rail showing background / progress / next
 * from the latest assistant turn). Defaults to ON; both atoms persist.
 */

const TASK_STATUS_RAIL_ENABLED_KEY = 'hermes.desktop.taskStatusRailEnabled'
const TASK_STATUS_RAIL_COLLAPSED_KEY = 'hermes.desktop.taskStatusRailCollapsed'

export const $taskStatusRailEnabled = persistentAtom(TASK_STATUS_RAIL_ENABLED_KEY, true)
export const $taskStatusRailCollapsed = persistentAtom(TASK_STATUS_RAIL_COLLAPSED_KEY, false)

export function toggleTaskStatusRail(): void {
  $taskStatusRailEnabled.set(!$taskStatusRailEnabled.get())
}

export function toggleTaskStatusRailCollapsed(): void {
  $taskStatusRailCollapsed.set(!$taskStatusRailCollapsed.get())
}
