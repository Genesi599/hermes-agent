import { useCallback, useEffect, useState } from 'react'

import { postChannelMessage } from '@/lib/channels'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { cn } from '@/lib/utils'

/**
 * ROOM MODEL SELECT — one dropdown to switch EVERY participant's model
 * (Hermes + all the room's agents) at once (2026-09-20 杨航).
 *
 * Zero new bridge surface: choosing an option simply POSTS `/model <id>` into
 * the room as a normal human line — the channel router already handles that
 * command inline (agent_model.py rewrites every participant's config.yaml;
 * the reply receipt lands in the room for everyone to see). The option list
 * is parsed from the DEFAULT profile's config.yaml (providers ∪ models) with
 * the same line-level regexes the python side uses; a model some agent lacks
 * is skipped per-profile and called out in the receipt, never a silent miss.
 */

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
  let inModelsList: string | null = null

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
      if (!inModelBlock) {
        continue
      }
    }
    if (/^providers:\s*$/.test(line)) {
      inProviders = true
      continue
    }
    if (inProviders) {
      if (line && !line.startsWith(' ')) {
        inProviders = false
        inModelsList = null
        continue
      }
      const modelLine = line.match(/^      ([^:\s]+):\s*\{?\}?\s*$/)
      if (modelLine && inModelsList) {
        available.add(modelLine[1])
        continue
      }
      if (/^    models:\s*$/.test(line)) {
        inModelsList = 'open'
        continue
      }
      if (line.startsWith('    ') && !line.startsWith('      ') && !/^    models:/.test(line)) {
        // A new provider entry resets the models list context.
        inModelsList = /^    models:/.test(line) ? inModelsList : null
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
      // No config readable → the select stays empty; /model typed by hand still works.
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
        // Post as a human line: the router's /model handler does the switch
        // and posts the receipt into the room right next to this control.
        await postChannelMessage(channelId, `/model ${modelId}`)
      } finally {
        setBusy(false)
      }
    },
    [busy, channelId]
  )

  if (config.available.length === 0) {
    return null
  }

  return (
    <select
      className={cn(
        'ml-auto h-6 max-w-40 truncate rounded-md border border-(--ui-stroke-tertiary)',
        'bg-transparent px-1.5 text-[0.625rem] text-(--ui-text-secondary) outline-none',
        busy && 'opacity-50'
      )}
      disabled={busy}
      onChange={event => {
        void change(event.target.value)
        event.currentTarget.value = config.current ?? ''
      }}
      title={`统一切换「${project}」全部参与者的模型（含 Hermes；下一轮生效）`}
      value={config.current ?? ''}
    >
      {config.current ? (
        <option value={config.current}>{config.current}</option>
      ) : (
        <option value="">模型</option>
      )}
      {config.available
        .filter(id => id !== config.current)
        .map(id => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
    </select>
  )
}
