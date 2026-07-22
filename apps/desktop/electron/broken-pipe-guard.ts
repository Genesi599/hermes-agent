import type { Writable } from 'node:stream'

const GUARDED_STREAM = Symbol.for('hermes.broken-pipe-guard')

interface GuardedWritable extends Writable {
  [GUARDED_STREAM]?: boolean
}

export function isBrokenPipeError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE')
}

export function guardBrokenPipe(stream: GuardedWritable | null | undefined): void {
  if (!stream || stream[GUARDED_STREAM]) {
    return
  }

  const originalWrite = stream.write.bind(stream)

  stream.write = ((...args: Parameters<Writable['write']>) => {
    try {
      return originalWrite(...args)
    } catch (error) {
      if (isBrokenPipeError(error)) {
        return false
      }

      throw error
    }
  }) as Writable['write']

  stream.on('error', error => {
    if (!isBrokenPipeError(error)) {
      process.nextTick(() => {
        throw error
      })
    }
  })

  stream[GUARDED_STREAM] = true
}

guardBrokenPipe(process.stdout)
guardBrokenPipe(process.stderr)
