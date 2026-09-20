import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'

// Mock the API layer BEFORE the roster imports it.
vi.mock('@/hermes', async importOriginal => {
  const real = await importOriginal<typeof import('@/hermes')>()
  return {
    ...real,
    listAllProfileSessions: vi.fn(async (limit: number, _min: number, _arch: string, _order: string, profile: string) => ({
      sessions:
        profile === 'plotter'
          ? [
              {
                id: '20260920_085919_01c1a1',
                title: '胸腺项目 · 绘图师',
                live_status: 'working',
                live_status_updated_at: Date.now() / 1000 - 2,
                status: 'working'
              }
            ]
          : []
    }))
  }
})

const agentsMock = [{ label: '绘图师', profile: 'plotter', avatar: '🎨' }]
vi.mock('@/store/cron', async () => {
  const { atom } = await import('nanostores')
  return { $cronJobs: atom([]) }
})
vi.mock('@/lib/session-agents', () => ({
  agentsForSession: () => agentsMock
}))
vi.mock('@/lib/channels', () => ({
  channelParticipants: () => ['绘图师'],
  roomBySession: async () => ({ id: 'ch1', project: '胸腺项目', title: '胸腺项目', participants: ['绘图师'] })
}))

vi.mock('@/store/projects', () => ({
  $projectScope: atom('__all__'),
  ALL_PROJECTS: '__all__',
  projectIdForCwd: () => null
}))

vi.mock('@/app/chat/sidebar/agent-roster', async importOriginal => {
  // keep everything real except the roomBySession channel fetch
  return importOriginal()
})

import { AgentRoster } from './agent-roster'
import { $agentActivity } from '@/store/agent-activity'

describe('AgentRoster working animation (production regression)', () => {
  beforeEach(() => {
    cleanup()
    $agentActivity.set({})
  })

  it('lights the agent chip while its conversation is working', async () => {
    render(
      <AgentRoster
        sessionId="room-1"
        sessionTitle="胸腺项目"
      />
    )

    const chip = await screen.findByText(/绘图师/)
    expect(chip).toBeTruthy()

    // registerAgentWatch fires an immediate first global poll on mount.
    await waitFor(
      () => {
        const el = [...document.querySelectorAll('[data-agent-state]')].find(node =>
          (node.textContent || '').includes('绘图师')
        )
        expect(el?.getAttribute('data-agent-state')).toBe('working')
      },
      { timeout: 4000 }
    )
  })
})
