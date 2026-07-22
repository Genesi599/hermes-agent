import { deflateSync } from 'node:zlib'

interface NativeImageLike {
  isEmpty: () => boolean
}

interface NativeImageFactory<T extends NativeImageLike> {
  createFromBuffer: (buffer: Buffer) => T
}

interface TaskbarWindow<T> {
  setOverlayIcon: (overlay: T | null, description: string) => void
}

const BADGE_SIZE = 16
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

export function normalizeTaskbarBadgeCount(value: unknown): number {
  const count = Number(value)

  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

export function taskbarBadgeLabel(count: number): string {
  const normalized = normalizeTaskbarBadgeCount(count)

  return normalized > 99 ? '99+' : String(normalized)
}

function setRgbaPixel(buffer: Buffer, x: number, y: number, color: readonly number[]) {
  if (x < 0 || x >= BADGE_SIZE || y < 0 || y >= BADGE_SIZE) {
    return
  }

  const offset = (y * BADGE_SIZE + x) * 4

  buffer[offset] = color[0]
  buffer[offset + 1] = color[1]
  buffer[offset + 2] = color[2]
  buffer[offset + 3] = color[3]
}

export function taskbarBadgeRgba(count: number): Buffer {
  const pixels = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4)
  const center = (BADGE_SIZE - 1) / 2

  for (let y = 0; y < BADGE_SIZE; y += 1) {
    for (let x = 0; x < BADGE_SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center)

      if (distance <= 7.4) {
        setRgbaPixel(pixels, x, y, distance > 6.35 ? [255, 255, 255, 255] : [34, 197, 94, 255])
      }
    }
  }

  const label = taskbarBadgeLabel(count)
  const scale = label.length <= 2 ? 2 : 1
  const glyphWidth = 3 * scale
  const spacing = scale
  const textWidth = label.length * glyphWidth + (label.length - 1) * spacing
  const startX = Math.floor((BADGE_SIZE - textWidth) / 2)
  const startY = Math.floor((BADGE_SIZE - 5 * scale) / 2)

  for (const [characterIndex, character] of [...label].entries()) {
    const glyph = GLYPHS[character]

    if (!glyph) {
      continue
    }

    for (const [rowIndex, row] of glyph.entries()) {
      for (const [columnIndex, bit] of [...row].entries()) {
        if (bit !== '1') {
          continue
        }

        for (let offsetY = 0; offsetY < scale; offsetY += 1) {
          for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            setRgbaPixel(
              pixels,
              startX + characterIndex * (glyphWidth + spacing) + columnIndex * scale + offsetX,
              startY + rowIndex * scale + offsetY,
              [255, 255, 255, 255]
            )
          }
        }
      }
    }
  }

  return pixels
}

let crcTable: Uint32Array | null = null

function pngCrc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)

    for (let index = 0; index < 256; index += 1) {
      let value = index

      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }

      crcTable[index] = value >>> 0
    }
  }

  let crc = 0xffffffff

  for (const value of buffer) {
    crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)

  length.writeUInt32BE(data.length)
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuffer, data])))

  return Buffer.concat([length, typeBuffer, data, crc])
}

export function taskbarBadgePng(count: number): Buffer {
  const pixels = taskbarBadgeRgba(count)
  const rows = Buffer.alloc((BADGE_SIZE * 4 + 1) * BADGE_SIZE)

  for (let y = 0; y < BADGE_SIZE; y += 1) {
    const rowOffset = y * (BADGE_SIZE * 4 + 1)

    rows[rowOffset] = 0
    pixels.copy(rows, rowOffset + 1, y * BADGE_SIZE * 4, (y + 1) * BADGE_SIZE * 4)
  }

  const header = Buffer.alloc(13)

  header.writeUInt32BE(BADGE_SIZE, 0)
  header.writeUInt32BE(BADGE_SIZE, 4)
  header[8] = 8
  header[9] = 6

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND')
  ])
}

export function setWindowsTaskbarBadge<T extends NativeImageLike>(
  window: TaskbarWindow<T>,
  nativeImageFactory: NativeImageFactory<T>,
  value: unknown
): boolean {
  const count = normalizeTaskbarBadgeCount(value)

  if (count === 0) {
    window.setOverlayIcon(null, '')

    return true
  }

  const image = nativeImageFactory.createFromBuffer(taskbarBadgePng(count))

  if (image.isEmpty()) {
    window.setOverlayIcon(null, '')

    return false
  }

  const description = `${count} completed ${count === 1 ? 'conversation' : 'conversations'} unread`

  window.setOverlayIcon(image, description)

  return true
}
