import { describe, expect, it } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { agentProfileSet, agentsForSession } from './session-agents'

function job(over: Record<string, unknown>): CronJob {
  return { id: 'j', name: 'job', ...over } as unknown as CronJob
}

describe('agentsForSession', () => {
  it('lists the producers that deliver into the session, in job order, de-duped', () => {
    const jobs = [
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '管家', agent_avatar: '🎩', agent_profile: 'steward' }),
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '流程搭档', agent_avatar: '🧭', agent_profile: 'advisor' }),
      // Same agent, second delivery job (the :40 reminder) — must not repeat.
      job({ attach_to_session: true, target_session_id: 'S1', agent_label: '管家', agent_avatar: '🎩', agent_profile: 'steward' })
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
    expect(agentsForSession([job({ attach_to_session: true, target_session_id: 'S1', agent_label: '   ' })], 'S1')).toEqual([])
    expect(agentsForSession([job({ attach_to_session: true, target_session_id: 'S1', agent_label: 'X' })], '  ')).toEqual([])
  })

  it('keeps a labelless-avatar agent usable and normalizes whitespace', () => {
    const jobs = [job({ attach_to_session: true, target_session_id: ' S1 ', agent_label: ' 顾问 ', agent_avatar: '  ', agent_profile: ' advisor ' })]

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
