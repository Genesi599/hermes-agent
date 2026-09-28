import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkdownTextContent } from './markdown-text'

afterEach(() => cleanup())

// The 带读 quote face: `> [!BOOK]` must render as an alert card whose body
// carries the .book-quote class (Times New Roman, slightly larger — see
// styles.css). Plain blockquotes must keep the ordinary quote styling.
describe('MarkdownTextContent book quotes', () => {
  it('renders > [!BOOK] as an alert with the book-quote body class', async () => {
    render(
      <MarkdownTextContent
        isRunning={false}
        text={'> [!BOOK]\n> I sit cross-legged on the floor. It\'s time for a proactive step.'}
      />
    )

    const body = document.querySelector('.book-quote')

    expect(body).not.toBeNull()
    expect(body?.textContent).toContain('cross-legged')
    expect(screen.getByText('原文')).toBeTruthy()
  })

  it('keeps plain blockquotes out of the book-quote class', () => {
    render(<MarkdownTextContent isRunning={false} text={'> just an ordinary quote'} />)

    expect(document.querySelector('.book-quote')).toBeNull()
  })
})
