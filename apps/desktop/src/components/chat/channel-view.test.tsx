import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Channel, ChannelMessage } from '@/lib/channels'
import { fetchChannelMessages, postChannelMessage } from '@/lib/channels'
import type * as Channels from '@/lib/channels'
import type * as ChatMessages from '@/lib/chat-messages'
import type * as Media from '@/lib/media'
import { notifyError } from '@/store/notifications'

import { ChannelView } from './channel-view'

// The room re-parsed EVERY line (two regexes over each line's whole content)
// on every keystroke until the draft moved into the composer and the lines got
// memoized — count the parses so that regression cannot come back.
const parses = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/chat-messages', async importOriginal => {
  const actual = await importOriginal<typeof ChatMessages>()

  return {
    ...actual,
    splitMediaRefs: (text: string) => {
      parses.count += 1

      return actual.splitMediaRefs(text)
    }
  }
})

vi.mock('@/lib/media', async importOriginal => {
  const actual = await importOriginal<typeof Media>()

  return { ...actual, resolveMediaDisplaySrc: vi.fn(async () => 'data:image/png;base64,AAAA') }
})

vi.mock('@/lib/channels', async importOriginal => {
  const actual = await importOriginal<typeof Channels>()

  return { ...actual, fetchChannelMessages: vi.fn(async () => []), postChannelMessage: vi.fn(async () => 1) }
})

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const saveImageBuffer = vi.fn(async (_data: ArrayBuffer | Uint8Array, _ext: string) => 'C:\\cache\\pasted.png')
const saveClipboardImage = vi.fn(async () => '')

const channel: Channel = {
  created_at: 0,
  id: 'ch_test',
  message_count: 0,
  participants: [],
  project: '测试',
  session_id: null,
  title: '测试房间',
  updated_at: 0
}

function line(id: number, content: string): ChannelMessage {
  return {
    author_avatar: null,
    author_kind: id % 2 === 0 ? 'agent' : 'human',
    author_label: id % 2 === 0 ? 'Hermes' : '杨航',
    channel_id: channel.id,
    content,
    id,
    role: 'user',
    timestamp: 1_700_000_000 + id
  }
}

const messages = Array.from({ length: 6 }, (_, index) => line(index + 1, `第 ${index + 1} 行内容`))

/** A paste event whose clipboardData carries files and/or text (jsdom has no
 *  real clipboard, so the DataTransfer is a stub — the same shape Chromium
 *  hands the handler). */
function paste(node: HTMLElement, data: { files?: File[]; text?: string }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }

  event.clipboardData = {
    files: data.files ?? [],
    getData: (type: string) => (type === 'text/plain' || type === 'text' ? (data.text ?? '') : '')
  }

  fireEvent(node, event)

  return event
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const box = container.querySelector<HTMLTextAreaElement>('[data-slot="channel-composer"]')

  if (!box) {
    throw new Error('the room composer did not render')
  }

  return box
}

beforeEach(() => {
  parses.count = 0
  vi.mocked(fetchChannelMessages).mockReset()
  vi.mocked(fetchChannelMessages).mockResolvedValue([])
  vi.mocked(postChannelMessage).mockClear()
  vi.mocked(notifyError).mockClear()
  saveImageBuffer.mockClear()
  saveImageBuffer.mockResolvedValue('C:\\cache\\pasted.png')
  saveClipboardImage.mockClear()
  saveClipboardImage.mockResolvedValue('')

  // The caret step runs in a frame; run it inline so assertions see the value
  // the user would.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)

    return 0
  })
  vi.stubGlobal('hermesDesktop', { saveClipboardImage, saveImageBuffer })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
})

describe('room composer paste', () => {
  it('writes a pasted image to disk and inserts its MEDIA: reference', async () => {
    const { container } = render(<ChannelView channel={channel} />)
    const box = composer(container)

    fireEvent.change(box, { target: { value: '看这张图 ' } })
    paste(box, { files: [new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' })] })

    await waitFor(() => expect(saveImageBuffer).toHaveBeenCalledTimes(1))
    expect(saveImageBuffer.mock.calls[0][1]).toBe('.png')
    expect(saveImageBuffer.mock.calls[0][0]).toBeInstanceOf(Uint8Array)
    // The ref lands on its OWN line, after the prose already in the box.
    await waitFor(() => expect(box.value).toBe('看这张图 \nMEDIA: C:\\cache\\pasted.png\n'))
    expect(saveClipboardImage).not.toHaveBeenCalled()
  })

  it('quotes a path with spaces so the reference parses back', async () => {
    saveImageBuffer.mockResolvedValueOnce('C:\\Users\\yh109\\My Shots\\shot 1.png')

    const { container } = render(<ChannelView channel={channel} />)
    paste(composer(container), { files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] })

    await waitFor(() => expect(composer(container).value).toBe('MEDIA: "C:\\Users\\yh109\\My Shots\\shot 1.png"\n'))
  })

  it('leaves a text paste alone', async () => {
    const { container } = render(<ChannelView channel={channel} />)
    const box = composer(container)

    await waitFor(() => expect(fetchChannelMessages).toHaveBeenCalled())
    const event = paste(box, { text: '普通文本' })

    expect(event.defaultPrevented).toBe(false)
    expect(saveImageBuffer).not.toHaveBeenCalled()
    expect(saveClipboardImage).not.toHaveBeenCalled()
  })

  it('asks the main process for the clipboard image when the paste is empty', async () => {
    saveClipboardImage.mockResolvedValueOnce('C:\\cache\\clip.png')

    const { container } = render(<ChannelView channel={channel} />)
    paste(composer(container), {})

    await waitFor(() => expect(saveClipboardImage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(composer(container).value).toBe('MEDIA: C:\\cache\\clip.png\n'))
  })

  it('stays silent when the clipboard holds no image at all', async () => {
    const { container } = render(<ChannelView channel={channel} />)
    paste(composer(container), {})

    await waitFor(() => expect(saveClipboardImage).toHaveBeenCalledTimes(1))
    expect(composer(container).value).toBe('')
    expect(notifyError).not.toHaveBeenCalled()
  })
})

describe('room render cost', () => {
  it('does not re-parse the room while typing', async () => {
    vi.mocked(fetchChannelMessages).mockResolvedValue(messages)

    const { container } = render(<ChannelView channel={channel} />)
    const box = composer(container)

    await waitFor(() => expect(parses.count).toBe(messages.length))

    fireEvent.change(box, { target: { value: '打' } })
    fireEvent.change(box, { target: { value: '打字' } })
    fireEvent.change(box, { target: { value: '打字中' } })

    expect(parses.count).toBe(messages.length)
  })

  it('keeps the room as-is when a poll brings nothing new', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchChannelMessages).mockResolvedValue(messages)

    render(<ChannelView channel={channel} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(parses.count).toBe(messages.length)

    vi.mocked(fetchChannelMessages).mockResolvedValue(messages.map(message => ({ ...message })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(parses.count).toBe(messages.length)
  })

  it('re-parses only the line a poll actually added', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchChannelMessages).mockResolvedValue(messages)

    const { container } = render(<ChannelView channel={channel} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(parses.count).toBe(messages.length)

    // Half-written line in the box while the room moves underneath it.
    fireEvent.change(composer(container), { target: { value: '正在打的一段话' } })

    const grown = [...messages, line(99, '新消息')]
    vi.mocked(fetchChannelMessages).mockResolvedValue(grown.map(message => ({ ...message })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(parses.count).toBe(messages.length + 1)
    // The new line lands and the draft is still there: the composer keeps its
    // own state, so an arriving message cannot wipe what is being typed.
    expect(container.querySelectorAll('[data-channel-author]').length).toBe(messages.length + 1)
    expect(composer(container).value).toBe('正在打的一段话')
  })
})
