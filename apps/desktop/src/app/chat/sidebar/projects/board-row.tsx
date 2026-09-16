import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { openPreview } from '@/store/preview'

/**
 * 公共看板 — the project's shared blackboard, maintained by Hermes.
 *
 * Lives at `<user home>/hermes_board/<project label>/{state.md,decisions.md,log.jsonl}`
 * (one board per project). Clicking opens the board as a read-only markdown
 * preview in the right rail, so the middle pane stays the conversation — board
 * beside the group chat, which is how the user wants to read the two together.
 *
 * The file is the truth source; the preview is only a view of it. A project
 * that has no board yet opens an empty/missing preview — the row is not a
 * writer.
 */
export function ProjectBoardRow({ projectLabel }: { projectLabel: string }) {
  return (
    <button
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pl-8 pr-2 text-left text-[0.6875rem] leading-4 text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground"
      data-slot="sidebar-project-board"
      onClick={async event => {
        // The project row itself enters the project — this only opens the board.
        event.preventDefault()
        event.stopPropagation()

        try {
          const home = await window.hermesDesktop.userHome()
          const target = await normalizeOrLocalPreviewTarget(`${home}/hermes_board/${projectLabel}/state.md`)

          if (target) {
            openPreview(target, 'file-browser')
          }
        } catch {
          // Preview is non-critical: a missing home/bridge just does nothing.
        }
      }}
      title={`打开「${projectLabel}」的公共看板（Hermes 维护）`}
      type="button"
    >
      <span aria-hidden="true">🗂</span>
      <span className="truncate">公共看板</span>
    </button>
  )
}
