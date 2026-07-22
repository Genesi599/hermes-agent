import { afterEach, describe, expect, it } from 'vitest'

import { $composerPoppedOut, COMPOSER_POPOUT_ENABLED, setComposerPoppedOut } from './composer-popout'

const POPOUT_ENABLED_STORAGE_KEY = 'hermes.desktop.composerPopout.enabled'

describe('composer pop-out', () => {
  afterEach(() => {
    setComposerPoppedOut(false)
    window.localStorage.removeItem(POPOUT_ENABLED_STORAGE_KEY)
  })

  it('keeps the composer docked when a pop-out path requests floating mode', () => {
    expect(COMPOSER_POPOUT_ENABLED).toBe(false)

    setComposerPoppedOut(true)

    expect($composerPoppedOut.get()).toBe(false)
    expect(window.localStorage.getItem(POPOUT_ENABLED_STORAGE_KEY)).toBe('false')
  })
})
