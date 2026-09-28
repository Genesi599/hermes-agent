import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CompactMarkdown } from './compact-markdown'

// Regression, 2026-09-21: a room line containing a plain-text tree
//
//   科研主线
//   └─ 胸腺新单细胞·初步分析结果
//      └─ OYdeg 表达差异分析
//
// rendered as ONE long line — markdown folds single newlines (soft breaks) into
// spaces, so the indentation and the tree glyphs lost their structure and the
// room read "在群聊里发的消息没有结构层次". The paragraph style must keep
// newlines and leading whitespace (whitespace-pre-wrap) so plain-text structure
// survives the markdown pass.
afterEach(cleanup)

describe('CompactMarkdown', () => {
  it('renders > [!BOOK] as an alert card with the book-quote class (room path)', () => {
    const text = '> [!BOOK]\n> I sit cross-legged on the floor.'

    const { container } = render(<CompactMarkdown text={text} />)

    expect(container.querySelector('.book-quote')).not.toBeNull()
    expect(container.querySelector('.book-quote')?.textContent).toContain('cross-legged')
    // The marker must not leak as raw text into the room card.
    expect(container.textContent).not.toContain('[!BOOK]')
  })

  it('keeps plain blockquotes compact-italic in the room path', () => {
    const { container } = render(<CompactMarkdown text={'> ordinary quote'} />)

    expect(container.querySelector('.book-quote')).toBeNull()
    expect(container.querySelector('blockquote')?.className).toContain('italic')
  })

  it('preserves newlines and indentation of plain-text structure', () => {
    const text = '科研主线\n└─ 胸腺新单细胞·初步分析结果\n   └─ OYdeg 表达差异分析'

    const { container } = render(<CompactMarkdown text={text} />)

    const paragraph = container.querySelector('p')
    expect(paragraph).not.toBeNull()
    expect(paragraph?.className).toContain('whitespace-pre-wrap')

    // The rendered text still holds the line breaks, not a single flattened line.
    const rendered = paragraph?.textContent ?? ''
    expect(rendered.split('\n').length).toBeGreaterThan(1)
  })

  it('keeps leading indentation of a plain-text tree (nbsp, not trimmed)', () => {
    const text = '科研主线\n└─ 胸腺新单细胞·初步分析结果\n   └─ OYdeg 表达差异分析\n      └─ ② 富集热图'

    const { container } = render(<CompactMarkdown text={text} />)

    const rendered = container.textContent ?? ''
    // The deeper levels must still carry their indent, as non-breaking spaces
    // (markdown would have trimmed real leading spaces away entirely).
    expect(rendered).toContain('\u00a0\u00a0\u00a0└─ OYdeg')
    expect(rendered).toContain('\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0└─ ② 富集热图')
  })

  it('keeps ordinary prose rendering as a single paragraph', () => {
    const { container } = render(<CompactMarkdown text="一句简单的话。" />)

    expect(container.querySelector('p')?.textContent).toBe('一句简单的话。')
  })
})
