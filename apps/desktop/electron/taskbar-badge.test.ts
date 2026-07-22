import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTaskbarBadgeCount,
  setWindowsTaskbarBadge,
  taskbarBadgeLabel,
  taskbarBadgePng,
  taskbarBadgeRgba
} from './taskbar-badge'

test('taskbar badge normalizes counts and caps the visible label', () => {
  assert.equal(normalizeTaskbarBadgeCount(-2), 0)
  assert.equal(normalizeTaskbarBadgeCount(3.8), 3)
  assert.equal(normalizeTaskbarBadgeCount('bad'), 0)
  assert.equal(taskbarBadgeLabel(7), '7')
  assert.equal(taskbarBadgeLabel(42), '42')
  assert.equal(taskbarBadgeLabel(100), '99+')
})

test('taskbar badge creates opaque green and white pixels in a valid PNG', () => {
  const pixels = taskbarBadgeRgba(12)
  let opaquePixels = 0
  let greenPixels = 0
  let whitePixels = 0

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4)

    if (alpha > 0) {
      opaquePixels += 1
    }

    if (red === 34 && green === 197 && blue === 94 && alpha === 255) {
      greenPixels += 1
    }

    if (red === 255 && green === 255 && blue === 255 && alpha === 255) {
      whitePixels += 1
    }
  }

  assert.ok(opaquePixels > 150)
  assert.ok(greenPixels > 40)
  assert.ok(whitePixels > 30)
  assert.equal(taskbarBadgePng(12).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})

test('zero unread clears the taskbar overlay without creating an image', () => {
  const calls: Array<{ description: string; overlay: unknown }> = []

  const window = {
    setOverlayIcon: (overlay: unknown, description: string) => calls.push({ description, overlay })
  }

  const factory = {
    createFromBuffer: () => {
      throw new Error('should not create an image for zero')
    }
  }

  assert.equal(setWindowsTaskbarBadge(window, factory, 0), true)
  assert.deepEqual(calls, [{ description: '', overlay: null }])
})

test('positive unread sends a real PNG image with an accessible description', () => {
  const calls: Array<{ description: string; overlay: unknown }> = []
  let source: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  const image = { isEmpty: () => false }

  const window = {
    setOverlayIcon: (overlay: unknown, description: string) => calls.push({ description, overlay })
  }

  const factory = {
    createFromBuffer: (buffer: Buffer) => {
      source = buffer

      return image
    }
  }

  assert.equal(setWindowsTaskbarBadge(window, factory, 3), true)
  assert.equal(source.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.deepEqual(calls, [{ description: '3 completed conversations unread', overlay: image }])
})
