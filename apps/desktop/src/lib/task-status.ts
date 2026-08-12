/**
 * Task-status sidebar support.
 *
 * The backend system prompt asks the model to close every turn with a small
 * structured block that describes the current task from the user's point of
 * view:
 *
 *   [HERMES_TASK_STATUS]{"background":"…","progress":"…","next":"…","skip":false}[/HERMES_TASK_STATUS]
 *
 * The block is stripped from the visible message body and rendered into a
 * per-session status rail instead (background / progress / next). `skip:true`
 * means "no task in flight" (chat / one-shot Q&A) — the rail keeps the
 * previous status rather than clearing it.
 *
 * Parsing is deliberately forgiving: a malformed block is dropped, never
 * shown, and never allowed to break the message body.
 */

export interface TaskStatus {
  /** One-line description of the current task / what the user is working toward. */
  background: string
  /** What has been done so far, in the current task. */
  progress: string
  /** What happens next. */
  next: string
  /** true = no active task; the rail should keep the previous status. */
  skip?: boolean
}

export const TASK_STATUS_BLOCK_RE = /\[HERMES_TASK_STATUS\]([\s\S]*?)\[\/HERMES_TASK_STATUS\]/g

/** Pull the first task-status block out of a message body, if any. */
export function parseTaskStatus(content: string): TaskStatus | null {
  if (!content) {return null}
  const match = content.match(/\[HERMES_TASK_STATUS\]([\s\S]*?)\[\/HERMES_TASK_STATUS\]/)
  if (!match) {return null}

  let raw: unknown
  try {
    raw = JSON.parse(match[1].trim())
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') {return null}

  const obj = raw as Record<string, unknown>
  const background = typeof obj.background === 'string' ? obj.background.trim() : ''
  const progress = typeof obj.progress === 'string' ? obj.progress.trim() : ''
  const next = typeof obj.next === 'string' ? obj.next.trim() : ''
  if (!background && !progress && !next) {return null}

  return { background, progress, next, skip: obj.skip === true }
}

/** Remove every task-status block from a message body (used before rendering). */
export function stripTaskStatusBlocks(content: string): string {
  if (!content || !content.includes('[HERMES_TASK_STATUS]')) {return content}
  return content.replace(TASK_STATUS_BLOCK_RE, '').trim()
}

/** True when the body carries at least one task-status block. */
export function hasTaskStatusBlock(content: string): boolean {
  return Boolean(content && content.includes('[HERMES_TASK_STATUS]'))
}
