import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { activeGateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { removeWorktreePath, startWorkInRepo } from '@/store/projects'
import { $currentCwd } from '@/store/session'
import { broadcastSessionsChanged } from '@/store/session-sync'

type WorkspaceMode = 'git_worktree' | 'shared' | 'shared_unique_outputs'

interface BranchDraft {
  key: string
  title: string
  prompt: string
  outputDir: string
  workspaceMode: WorkspaceMode
  model: string
  provider: string
}

interface ConversationBranchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSessionId: null | string
  runtimeSessionId: null | string
}

interface BranchBatchResponse {
  batch_id: string
  created_count: number
  queued_count: number
}

const newDraft = (index: number): BranchDraft => ({
  key: `branch-${index}-${crypto.randomUUID().slice(0, 6)}`,
  model: '',
  outputDir: '',
  prompt: '',
  provider: '',
  title: '',
  workspaceMode: 'shared'
})

export function ConversationBranchDialog({
  open,
  onOpenChange,
  parentSessionId,
  runtimeSessionId
}: ConversationBranchDialogProps) {
  const { t } = useI18n()
  const copy = t.sidebar.branchBatch
  const [drafts, setDrafts] = useState<BranchDraft[]>([newDraft(1)])
  const [maxParallel, setMaxParallel] = useState(3)
  const [autoStart, setAutoStart] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const currentCwd = useStore($currentCwd)

  useEffect(() => {
    if (!open) {
      setReviewing(false)
      setSubmitting(false)
    }
  }, [open])

  const valid = useMemo(
    () =>
      Boolean(parentSessionId && runtimeSessionId) &&
      drafts.length > 0 &&
      drafts.every(
        draft =>
          draft.title.trim() &&
          draft.prompt.trim() &&
          (draft.workspaceMode !== 'shared_unique_outputs' || draft.outputDir.trim())
      ) &&
      new Set(
        drafts
          .filter(draft => draft.workspaceMode === 'shared_unique_outputs')
          .map(draft => draft.outputDir.trim().toLocaleLowerCase())
      ).size === drafts.filter(draft => draft.workspaceMode === 'shared_unique_outputs').length,
    [drafts, parentSessionId, runtimeSessionId]
  )

  const updateDraft = (key: string, patch: Partial<BranchDraft>) =>
    setDrafts(current => current.map(draft => (draft.key === key ? { ...draft, ...patch } : draft)))

  const submit = async () => {
    const gateway = activeGateway()

    if (!gateway || !parentSessionId || !runtimeSessionId || !valid || submitting) {
      notify({ kind: 'warning', message: copy.requiresSession })

      return
    }

    setSubmitting(true)
    const createdWorktrees: string[] = []

    try {
      const branches = []

      for (const draft of drafts) {
        let cwd: string | undefined
        let outputDir = draft.outputDir.trim() || undefined

        if (draft.workspaceMode === 'git_worktree') {
          if (!currentCwd) {
            throw new Error(copy.worktreeRequiresRepo)
          }

          const worktree = await startWorkInRepo(currentCwd, { name: draft.key })

          if (!worktree) {
            throw new Error(copy.worktreeRequiresRepo)
          }

          cwd = worktree.path
          outputDir = worktree.path
          createdWorktrees.push(worktree.path)
        }

        branches.push({
          auto_start: autoStart,
          client_branch_key: draft.key,
          cwd,
          initial_prompt: draft.prompt.trim(),
          model: draft.model.trim() || undefined,
          output_dir: outputDir,
          provider: draft.provider.trim() || undefined,
          title: draft.title.trim(),
          workspace_mode: draft.workspaceMode
        })
      }

      await gateway.request<BranchBatchResponse>('session.branch_batch', {
        branches,
        max_parallel: maxParallel,
        parent_session_id: parentSessionId,
        request_id: crypto.randomUUID(),
        runtime_session_id: runtimeSessionId
      })
      broadcastSessionsChanged()
      notify({ durationMs: 3_000, kind: 'success', message: copy.created })
      onOpenChange(false)
      setDrafts([newDraft(1)])
    } catch (error) {
      if (currentCwd) {
        await Promise.allSettled(
          createdWorktrees.map(path => removeWorktreePath(currentCwd, path, { force: true }))
        )
      }

      notifyError(error, copy.failed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1">
          {reviewing ? (
            <div className="grid gap-3 py-1">
              {drafts.map((draft, index) => (
                <div className="border-b border-(--ui-stroke-tertiary) pb-3 last:border-0" key={draft.key}>
                  <div className="text-sm font-medium">{draft.title || copy.taskNumber(index + 1)}</div>
                  <div className="mt-1 line-clamp-3 text-xs text-(--ui-text-secondary)">{draft.prompt}</div>
                  <div className="mt-1 text-[0.6875rem] text-(--ui-text-tertiary)">
                    {[draft.workspaceMode, draft.model || copy.inherit, draft.provider || copy.inherit].join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 py-1">
              {drafts.map((draft, index) => (
                <section className="border-b border-(--ui-stroke-tertiary) pb-4 last:border-0" key={draft.key}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-(--ui-text-secondary)">{copy.taskNumber(index + 1)}</span>
                    <Tip label={copy.removeTask}>
                      <Button
                        aria-label={copy.removeTask}
                        disabled={drafts.length === 1}
                        onClick={() => setDrafts(current => current.filter(item => item.key !== draft.key))}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <Codicon name="trash" size="0.75rem" />
                      </Button>
                    </Tip>
                  </div>
                  <div className="grid gap-2">
                    <Input
                      aria-label={copy.taskTitle}
                      onChange={event => updateDraft(draft.key, { title: event.target.value })}
                      placeholder={copy.taskTitle}
                      value={draft.title}
                    />
                    <Textarea
                      aria-label={copy.prompt}
                      onChange={event => updateDraft(draft.key, { prompt: event.target.value })}
                      placeholder={copy.prompt}
                      rows={3}
                      value={draft.prompt}
                    />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Select
                        onValueChange={(value: WorkspaceMode) => updateDraft(draft.key, { workspaceMode: value })}
                        value={draft.workspaceMode}
                      >
                        <SelectTrigger aria-label={copy.workspaceMode}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="shared">{copy.shared}</SelectItem>
                          <SelectItem value="shared_unique_outputs">{copy.sharedUniqueOutputs}</SelectItem>
                          <SelectItem value="git_worktree">{copy.gitWorktree}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        aria-label={copy.model}
                        onChange={event => updateDraft(draft.key, { model: event.target.value })}
                        placeholder={copy.model}
                        value={draft.model}
                      />
                      <Input
                        aria-label={copy.provider}
                        onChange={event => updateDraft(draft.key, { provider: event.target.value })}
                        placeholder={copy.provider}
                        value={draft.provider}
                      />
                    </div>
                    {draft.workspaceMode === 'shared_unique_outputs' ? (
                      <Input
                        aria-label={copy.outputDir}
                        onChange={event => updateDraft(draft.key, { outputDir: event.target.value })}
                        placeholder={copy.outputDir}
                        value={draft.outputDir}
                      />
                    ) : null}
                  </div>
                </section>
              ))}
              <Button
                disabled={drafts.length >= 10}
                onClick={() => setDrafts(current => [...current, newDraft(current.length + 1)])}
                type="button"
                variant="secondary"
              >
                <Codicon name="add" size="0.875rem" />
                {copy.addTask}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-xs text-(--ui-text-secondary)">
                  <span>{copy.maxParallel}</span>
                  <Input
                    className="w-16"
                    max={10}
                    min={1}
                    onChange={event => setMaxParallel(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
                    type="number"
                    value={maxParallel}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-(--ui-text-secondary)">
                  <span>{copy.autoStart}</span>
                  <Switch checked={autoStart} onCheckedChange={setAutoStart} size="xs" />
                </label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          {reviewing ? (
            <>
              <Button disabled={submitting} onClick={() => setReviewing(false)} type="button" variant="secondary">
                {copy.back}
              </Button>
              <Button disabled={!valid || submitting} onClick={() => void submit()} type="button">
                {copy.create}
              </Button>
            </>
          ) : (
            <Button disabled={!valid} onClick={() => setReviewing(true)} type="button">
              {copy.preview}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
