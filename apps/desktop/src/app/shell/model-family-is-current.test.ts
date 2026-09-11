import { describe, expect, it } from 'vitest'

import { modelFamilyIsCurrent } from './model-catalog-menu'

const SLUGS = ['deepseek_api', 'glm-coding', 'kimi-k3-cn']

describe('modelFamilyIsCurrent (custom-provider highlight fallback)', () => {
  it('matches by provider slug for built-in/named provider sessions', () => {
    expect(
      modelFamilyIsCurrent({ model: 'glm-5.3', provider: 'glm-coding' }, SLUGS, 'glm-coding', {
        id: 'glm-5.3',
        fastId: 'glm-5.3-flash'
      })
    ).toBe(true)
    expect(
      modelFamilyIsCurrent({ model: 'glm-5.3', provider: 'glm-coding' }, SLUGS, 'deepseek_api', {
        id: 'glm-5.3',
        fastId: null
      })
    ).toBe(false)
  })

  it("matches the -fast sibling row for the session's active fast model", () => {
    expect(
      modelFamilyIsCurrent({ model: 'glm-5.3-flash', provider: 'glm-coding' }, SLUGS, 'glm-coding', {
        id: 'glm-5.3',
        fastId: 'glm-5.3-flash'
      })
    ).toBe(true)
  })

  it("falls back to model-id matching when the session reports provider='custom'", () => {
    // session.info on a custom provider carries the generic 'custom' slug —
    // the case that used to leave the current model completely unmarked.
    expect(
      modelFamilyIsCurrent({ model: 'glm-5.3', provider: 'custom' }, SLUGS, 'glm-coding', {
        id: 'glm-5.3',
        fastId: null
      })
    ).toBe(true)
    expect(
      modelFamilyIsCurrent({ model: 'glm-5.3', provider: 'custom' }, SLUGS, 'kimi-k3-cn', {
        id: 'kimi-k3',
        fastId: null
      })
    ).toBe(false)
  })

  it('never matches an empty provider or the virtual moa provider', () => {
    const family = { id: 'glm-5.3', fastId: null }

    expect(modelFamilyIsCurrent({ model: 'glm-5.3', provider: '' }, SLUGS, 'glm-coding', family)).toBe(false)
    expect(modelFamilyIsCurrent({ model: 'glm-5.3', provider: 'moa' }, SLUGS, 'glm-coding', family)).toBe(false)
  })
})
