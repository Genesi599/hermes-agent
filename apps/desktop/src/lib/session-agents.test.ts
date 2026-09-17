import { describe, expect, it } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { agentProfileSet, agentsForSession, isHermesConversation } from './session-agents'

function job(over: Record<string, unknown>): CronJob {
  return { id: 'j', name: 'job', ...over } as unknown as CronJob
}

describe('agentsForSession', () => {
  it('lists the producers that deliver into the session, in job order, de-duped', () => {
    const jobs = [
      job({
        attach_to_session: true,
        target_session_id: 'S1',
        agent_label: '管家',
        agent_avatar: '🎩',
        agent_profile: 'steward'
      }),
      job({
        attach_to_session: true,
        target_session_id: 'S1',
        agent_label: '流程搭档',
        agent_avatar: '🧭',
        agent_profile: 'advisor'
      }),
      // Same agent, second delivery job (the :40 reminder) — must not repeat.
      job({
        attach_to_session: true,
        target_session_id: 'S1',
        agent_label: '管家',
        agent_avatar: '🎩',
        agent_profile: 'steward'
      })
    ]

    expect(agentsForSession(jobs, 'S1')).toEqual([
      { label: '管家', avatar: '🎩', profile: 'steward' },
      { label: '流程搭档', avatar: '🧭', profile: 'advisor' }
    ])
  })

  it('ignores jobs bound to other sessions, unbound jobs, and unlabelled jobs', () => {
    const jobs = [
      job({ attach_to_session: true, target_session_id: 'S2', agent_label: '别的' }),
      job({ target_session_id: 'S1', agent_label: '没开 attach' }),
      job({ attach_to_session: true, target_session_id: 'S1' })
    ]

    expect(agentsForSession(jobs, 'S1')).toEqual([])
  })

  it('tolerates missing/blank fields and a missing list', () => {
    expect(agentsForSession(undefined, 'S1')).toEqual([])
    expect(agentsForSession([], 'S1')).toEqual([])
    expect(
      agentsForSession([job({ attach_to_session: true, target_session_id: 'S1', agent_label: '   ' })], 'S1')
    ).toEqual([])
    expect(
      agentsForSession([job({ attach_to_session: true, target_session_id: 'S1', agent_label: 'X' })], '  ')
    ).toEqual([])
  })

  it('keeps a labelless-avatar agent usable and normalizes whitespace', () => {
    const jobs = [
      job({
        attach_to_session: true,
        target_session_id: ' S1 ',
        agent_label: ' 顾问 ',
        agent_avatar: '  ',
        agent_profile: ' advisor '
      })
    ]

    expect(agentsForSession(jobs, 'S1')).toEqual([{ label: '顾问', avatar: undefined, profile: 'advisor' }])
  })
})

describe('agentProfileSet', () => {
  it('collects the profiles marked as agents on any delivery job, ignoring the rest', () => {
    const jobs = [
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '管家', agent_profile: 'steward' }),
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '流程搭档', agent_profile: 'advisor' }),
      job({ attach_to_session: true, target_session_id: 'S2', agent_label: '管家', agent_profile: 'steward' }),
      job({ attach_to_session: true, target_session_id: 'S1' })
    ]

    expect([...agentProfileSet(jobs)].sort()).toEqual(['advisor', 'steward'])
  })

  it('is empty without jobs', () => {
    expect(agentProfileSet(undefined).size).toBe(0)
    expect(agentProfileSet([]).size).toBe(0)
  })
})

describe('isHermesConversation', () => {
  it('recognizes Hermes project conversations, counter and all', () => {
    expect(isHermesConversation('星阶 · Hermes')).toBe(true)
    expect(isHermesConversation('星阶 · Hermes (2)')).toBe(true)
    expect(isHermesConversation('  B Cell Aging · Hermes  ')).toBe(true)
  })

  it('leaves the room, other agents, and self-named chats alone', () => {
    // The room is named after the project itself — no agent suffix.
    expect(isHermesConversation('星阶')).toBe(false)
    // Another agent's conversation is filtered by its PROFILE, not by name.
    expect(isHermesConversation('星阶 · 流程搭档')).toBe(false)
    expect(isHermesConversation('Hermes')).toBe(false)
    expect(isHermesConversation('和 Hermes 聊 · 关于 Hermes')).toBe(false)
    expect(isHermesConversation('')).toBe(false)
    expect(isHermesConversation(null)).toBe(false)
    expect(isHermesConversation(undefined)).toBe(false)
  })
})

describe('main-agent delivery job', () => {
  it('does not add a second chip for the room maintainer', () => {
    const jobs = [
      // Hermes's own delivery job: same shape every agent's has, but its chip
      // is rendered by the roster itself.
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: 'Hermes' }),
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '管家', agent_profile: 'steward' })
    ]

    expect(agentsForSession(jobs, 'S1').map(agent => agent.label)).toEqual(['管家'])
  })
})
