import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { test } from 'vitest'

import { guardBrokenPipe, isBrokenPipeError } from './broken-pipe-guard'

test('isBrokenPipeError only accepts EPIPE errors', () => {
  assert.equal(isBrokenPipeError(Object.assign(new Error('closed'), { code: 'EPIPE' })), true)
  assert.equal(isBrokenPipeError(Object.assign(new Error('missing'), { code: 'ENOENT' })), false)
  assert.equal(isBrokenPipeError(null), false)
})

test('guardBrokenPipe suppresses a synchronous EPIPE write', () => {
  const stream = new PassThrough()
  const error = Object.assign(new Error('closed'), { code: 'EPIPE' })

  stream.write = (() => {
    throw error
  }) as typeof stream.write

  guardBrokenPipe(stream)

  assert.equal(stream.write('warning'), false)
})

test('guardBrokenPipe preserves non-EPIPE write failures', () => {
  const stream = new PassThrough()
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' })

  stream.write = (() => {
    throw error
  }) as typeof stream.write

  guardBrokenPipe(stream)

  assert.throws(() => stream.write('warning'), error)
})
