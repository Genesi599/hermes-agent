import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SidebarRowLabel } from './chrome'

describe('SidebarRowLabel typography', () => {
  afterEach(cleanup)

  it('reserves enough line height for Latin descenders', () => {
    render(<SidebarRowLabel>Log gy</SidebarRowLabel>)

    const label = screen.getByText('Log gy')
    expect(label.className).toContain('leading-5')
    expect(label.className).not.toContain('leading-4')
    expect(label.className).not.toContain('leading-none')
  })
})
