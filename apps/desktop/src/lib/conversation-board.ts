import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { openPreview } from '@/store/preview'

/**
 * Open a conversation's board, if it has one.
 *
 * A conversation IS its project, so its board lives at
 * `<user home>/hermes_board/<conversation title>/state.md` (Hermes maintains it).
 * Opening a conversation therefore also surfaces the board in the right rail —
 * group chat in the middle, board beside it.
 *
 * Existence is checked with the directory listing, NOT by trying to resolve the
 * preview: `normalizeOrLocalPreviewTarget` falls through to renderer-side
 * classification on older Electron and returns a target even for a missing
 * file, which would open an erroring panel on every board-less conversation.
 */
function entryName(entry: unknown): string {
  if (!entry || typeof entry !== 'object') {
    return ''
  }

  const record = entry as Record<string, unknown>

  for (const key of ['name', 'fileName', 'basename']) {
    const value = record[key]

    if (typeof value === 'string' && value) {
      return value
    }
  }

  const path = typeof record.path === 'string' ? record.path : ''

  return path ? (path.split(/[\\/]/).pop() ?? '') : ''
}

export async function openConversationBoard(title: null | string | undefined): Promise<void> {
  const name = (title || '').trim()

  if (!name) {
    return
  }

  const desktop = window.hermesDesktop

  if (!desktop?.userHome || !desktop?.readDir) {
    return
  }

  try {
    const root = `${(await desktop.userHome()).replace(/[\\/]+$/, '')}/hermes_board`
    const listing = await desktop.readDir(root)

    if (listing?.error || !(listing?.entries ?? []).some(entry => entryName(entry) === name)) {
      return
    }

    const target = await normalizeOrLocalPreviewTarget(`${root}/${name}/state.md`)

    if (target) {
      openPreview(target, 'file-browser')
    }
  } catch {
    // A conversation must open even when the board bridge is unavailable.
  }
}
