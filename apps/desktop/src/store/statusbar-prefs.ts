import { Codecs, persistentAtom } from '@/lib/persisted'

const STATUSBAR_HIDDEN_STORAGE_KEY = 'hermes.desktop.statusbarHidden'
const STATUSBAR_VISIBLE_STORAGE_KEY = 'hermes.desktop.statusbarVisible'

// Whole-bar visibility, VS Code's `workbench.statusBar.visible`. Off by default
// — the bar is opt-in. Hiding it unmounts the bar (its 15s status poll goes with
// it), so the way back is the `view.toggleStatusbar` keybind or the ⌘K row,
// never the bar itself.
export const $statusbarVisible = persistentAtom(STATUSBAR_VISIBLE_STORAGE_KEY, false, Codecs.bool)

export function toggleStatusbarVisible() {
  $statusbarVisible.set(!$statusbarVisible.get())
}

// Items the bar hides until the user turns them on from its context menu. The
// bar's job is to answer "is the backend healthy, where am I, what's it doing" —
// route shortcuts (cron/webhooks/agents), the terminal toggle, and the approval
// pill are navigation, not status, so they start out of the way. The timers are
// diagnostics most users don't watch, while context usage remains visible so
// the user can see how close the current conversation is to its model limit.
export const STATUSBAR_HIDDEN_BY_DEFAULT: readonly string[] = [
  'agents',
  'approval-mode',
  'cron',
  'running-timer',
  'session-timer',
  'terminal',
  'webhooks'
]

const LEGACY_CONTEXT_USAGE_ID = 'context-usage'
const LEGACY_DEFAULT_HIDDEN_IDS = new Set([...STATUSBAR_HIDDEN_BY_DEFAULT, LEGACY_CONTEXT_USAGE_ID])

export function migrateLegacyContextVisibility(hidden: readonly string[]): string[] {
  if (
    !hidden.includes(LEGACY_CONTEXT_USAGE_ID) ||
    !hidden.every(id => LEGACY_DEFAULT_HIDDEN_IDS.has(id))
  ) {
    return [...hidden]
  }

  return hidden.filter(id => id !== LEGACY_CONTEXT_USAGE_ID)
}

// Stored as the explicit hidden set (not the visible one) so an item added to
// the bar in a later version shows up for existing users instead of silently
// staying off. An empty array is a real value — the user turned everything on —
// so this uses a sanitizing json codec rather than Codecs.stringArray, which
// drops the key when empty and would resurrect the defaults on next launch.
export const $statusbarHiddenIds = persistentAtom<string[]>(
  STATUSBAR_HIDDEN_STORAGE_KEY,
  [...STATUSBAR_HIDDEN_BY_DEFAULT],
  Codecs.json<string[]>(value =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  )
)

const storedHiddenIds = $statusbarHiddenIds.get()
const migratedHiddenIds = migrateLegacyContextVisibility(storedHiddenIds)

if (migratedHiddenIds.length !== storedHiddenIds.length) {
  $statusbarHiddenIds.set(migratedHiddenIds)
}

export function setStatusbarItemVisible(id: string, visible: boolean) {
  const hidden = $statusbarHiddenIds.get()

  if (visible === !hidden.includes(id)) {
    return
  }

  $statusbarHiddenIds.set(visible ? hidden.filter(entry => entry !== id) : [...hidden, id])
}
