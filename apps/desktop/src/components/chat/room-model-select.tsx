import { useCallback, useEffect, useMemo, useState } from 'react'

import { postChannelMessage } from '@/lib/channels'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/lib/icons'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { cn } from '@/lib/utils'

/**
 * ROOM MODEL PILL — the room composer's model switcher, styled after the
 * private-chat composer's ModelPill (same pill chrome + dropdown + chevron).
 * Semantics are the ROOM's, not a session's: picking a model switches EVERY
 * participant (Hermes + this room's agents) at once — next turn onwards.
 *
 * PROVIDER-QUALIFIED (2026-09-20 杨航): the same model id can exist under
 * several providers (glm-5.3 under glm-coding AND zai-payg — different keys
 * and price tiers), so every option carries its provider: the menu is grouped
 * by provider and the pick posts `/model <provider>/<model>` — the python side
 * rewrites both `model.default` and `model.provider` explicitly, no guessing.
 *
 * Zero new bridge surface: the pick POSTS `/model …` into the room as a human
 * line; the channel router handles that command inline (agent_model.py) and
 * the receipt lands in the room. Options come from the DEFAULT profile's
 * config.yaml, line-parsed the same way the python side does it.
 */

const PILL = cn(
  'h-(--composer-control-size) max-w-40 shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

interface ModelConfig {
  current: null | string // "provider/model"
  groups: { provider: string; models: string[] }[]
}

const EMPTY: ModelConfig = { current: null, groups: [] }

function parseConfigYamlModels(text: string): ModelConfig {
  const lines = text.split(/\r?\n/)
  let currentProvider: null | string = null
  let currentModel: null | string = null
  const byProvider = new Map<string, Set<string>>()
  let inModelBlock = false
  let inProviders = false
  let inModelsList = false
  let provider = ''

  for (const line of lines) {
    if (/^model:\s*$/.test(line)) {
      inModelBlock = true
      continue
    }
    if (inModelBlock) {
      const def = line.match(/^  default:\s*(\S+)/)
      if (def) {
        currentModel = def[1]
      }
      const prov = line.match(/^  provider:\s*(\S+)/)
      if (prov) {
        currentProvider = prov[1]
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
      if (modelLine && inModelsList && provider) {
        byProvider.get(provider)?.add(modelLine[1])
        continue
      }
      const provHead = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
      if (provHead && !line.startsWith('    ')) {
        provider = provHead[1]
        byProvider.set(provider, new Set())
        inModelsList = false
        continue
      }
      if (line.startsWith('    ') && !line.startsWith('      ') && !/^    models:/.test(line)) {
        inModelsList = false
      }
    }
  }

  return {
    current: currentProvider && currentModel ? `${currentProvider}/${currentModel}` : null,
    groups: [...byProvider.entries()].map(([p, models]) => ({ provider: p, models: [...models].sort() }))
  }
}

export function RoomModelSelect({ channelId, project }: { channelId: string; project: string }) {
  const [config, setConfig] = useState<ModelConfig>(EMPTY)
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

  const currentLabel = useMemo(() => config.current?.split('/')[1] ?? config.current ?? '模型', [config.current])

  const change = useCallback(
    async (spec: string) => {
      if (!spec || busy) {
        return
      }
      setBusy(true)
      try {
        // Post as a human line: the router's /model handler switches every
        // participant and posts the receipt right above this composer.
        await postChannelMessage(channelId, `/model ${spec}`)
        await load()
      } finally {
        setBusy(false)
      }
    },
    [busy, channelId, load]
  )

  if (config.groups.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={PILL} disabled={busy} size="sm" variant="ghost" title={config.current ?? undefined}>
          <span className="max-w-28 truncate">{currentLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {config.groups.map(group => (
          <div key={group.provider}>
            <DropdownMenuLabel className="text-[0.625rem] text-(--ui-text-quaternary)">{group.provider}</DropdownMenuLabel>
            {group.models.map(id => {
              const spec = `${group.provider}/${id}`
              const isCurrent = spec === config.current
              return (
                <DropdownMenuItem
                  key={spec}
                  onSelect={() => {
                    void change(spec)
                  }}
                >
                  <span className={cn(isCurrent && 'font-semibold')}>{id}</span>
                  {isCurrent ? <span className="ml-auto text-[0.625rem] text-(--ui-text-quaternary)">当前</span> : null}
                </DropdownMenuItem>
              )
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
