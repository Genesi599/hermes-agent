import { useCallback, useEffect, useState } from 'react'

import { postChannelMessage } from '@/lib/channels'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/lib/icons'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { cn } from '@/lib/utils'

/**
 * ROOM MODEL PILL — the room composer's model switcher, styled after the
 * private-chat composer's ModelPill (same pill chrome + dropdown + chevron;
 * 2026-09-20 杨航: 「复用私聊聊天框右边的那种形式」). Semantics are the ROOM's,
 * not a session's: picking a model switches EVERY participant (Hermes + this
 * room's agents) at once — next turn onwards.
 *
 * Zero new bridge surface: the pick POSTS `/model <id>` into the room as a
 * human line; the channel router handles that command inline (agent_model.py
 * rewrites every participant's config.yaml) and the receipt lands in the room.
 * Options come from the DEFAULT profile's config.yaml (providers ∪ models),
 * line-parsed the same way the python side does it.
 */

const PILL = cn(
  'h-(--composer-control-size) max-w-40 shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

interface ModelConfig {
  current: null | string
  available: string[]
}

function parseConfigYamlModels(text: string): ModelConfig {
  const lines = text.split(/\r?\n/)
  let current: null | string = null
  const available = new Set<string>()
  let inModelBlock = false
  let inProviders = false
  let inModelsList = false

  for (const line of lines) {
    if (/^model:\s*$/.test(line)) {
      inModelBlock = true
      continue
    }
    if (inModelBlock) {
      const def = line.match(/^  default:\s*(\S+)/)
      if (def) {
        current = def[1]
      }
      if (line && !line.startsWith(' ')) {
        inModelBlock = false
      }
    }
    if (/^providers:\s*$/.test(line)) {
      inProviders = true
      continue
    }
    if (inProviders) {
      if (line && !line.startsWith(' ')) {
        inProviders = false
        inModelsList = false
        continue
      }
      if (/^    models:\s*$/.test(line)) {
        inModelsList = true
        continue
      }
      const modelLine = line.match(/^      ([^:\s]+):\s*\{?\}?\s*$/)
      if (modelLine && inModelsList) {
        available.add(modelLine[1])
        continue
      }
      if (line.startsWith('    ') && !line.startsWith('      ') && !/^    models:/.test(line)) {
        // A provider-level key other than `models:` ends the model list context.
        inModelsList = false
      }
    }
  }

  return { current, available: [...available].sort() }
}

export function RoomModelSelect({ channelId, project }: { channelId: string; project: string }) {
  const [config, setConfig] = useState<ModelConfig>({ current: null, available: [] })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const home = await window.hermesDesktop?.userHome?.()
      const result = home ? await readDesktopFileText(`${home}\\AppData\\Local\\hermes\\config.yaml`) : null
      const text = result && typeof result.text === 'string' ? result.text : null
      if (text) {
        setConfig(parseConfigYamlModels(text))
      }
    } catch {
      // No config readable → the pill stays hidden; /model typed by hand still works.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const change = useCallback(
    async (modelId: string) => {
      if (!modelId || busy) {
        return
      }
      setBusy(true)
      try {
        // Post as a human line: the router's /model handler switches every
        // participant and posts the receipt right above this composer.
        await postChannelMessage(channelId, `/model ${modelId}`)
        // The default config flips immediately — refresh the pill's label.
        await load()
      } finally {
        setBusy(false)
      }
    },
    [busy, channelId, load]
  )

  if (config.available.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={PILL} disabled={busy} size="sm" variant="ghost">
          <span className="max-w-28 truncate">{config.current ?? '模型'}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {config.available.map(id => (
          <DropdownMenuItem
            key={id}
            onSelect={() => {
              void change(id)
            }}
          >
            <span className={cn(id === config.current && 'font-semibold')}>{id}</span>
            {id === config.current ? <span className="ml-auto text-[0.625rem] text-(--ui-text-quaternary)">当前</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
