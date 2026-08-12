import { describe, expect, it } from 'vitest'

import { hasTaskStatusBlock, parseTaskStatus, stripTaskStatusBlocks } from './task-status'

const BLOCK = (json: string) => `[HERMES_TASK_STATUS]${json}[/HERMES_TASK_STATUS]`

describe('parseTaskStatus', () => {
  it('parses a well-formed block', () => {
    const status = parseTaskStatus(
      `分析 PBMC 数据。\n\n${BLOCK(JSON.stringify({ background: '分析 PBMC', progress: '已跑完反卷积', next: '做差异分析', skip: false }))}`
    )
    expect(status).toEqual({
      background: '分析 PBMC',
      progress: '已跑完反卷积',
      next: '做差异分析',
      skip: false
    })
  })

  it('returns null when no block is present', () => {
    expect(parseTaskStatus('普通回复，没有状态块')).toBeNull()
    expect(parseTaskStatus('')).toBeNull()
  })

  it('returns null for malformed JSON inside the block', () => {
    expect(parseTaskStatus(BLOCK('{not json}'))).toBeNull()
    expect(parseTaskStatus(BLOCK(''))).toBeNull()
  })

  it('returns null when all fields are empty (skip case)', () => {
    expect(parseTaskStatus(BLOCK('{"background":"","progress":"","next":"","skip":true}'))).toBeNull()
  })

  it('flags skip', () => {
    const status = parseTaskStatus(BLOCK('{"background":"x","progress":"y","next":"z","skip":true}'))
    expect(status?.skip).toBe(true)
  })

  it('tolerates trailing text after the block', () => {
    const status = parseTaskStatus(`${BLOCK(JSON.stringify({ background: 'a', progress: 'b', next: 'c' }))}\n补充说明`)
    expect(status?.background).toBe('a')
  })
})

describe('stripTaskStatusBlocks', () => {
  it('removes the block and trims the body', () => {
    const stripped = stripTaskStatusBlocks(
      `正文内容\n\n${BLOCK('{"background":"a","progress":"b","next":"c"}')}\n`
    )
    expect(stripped).toBe('正文内容')
  })

  it('returns input unchanged when no block present', () => {
    expect(stripTaskStatusBlocks('普通回复')).toBe('普通回复')
    expect(stripTaskStatusBlocks('')).toBe('')
  })

  it('removes multiple blocks', () => {
    const stripped = stripTaskStatusBlocks(
      `第一段${BLOCK('{"background":"a","progress":"b","next":"c"}')}中间${BLOCK('{"background":"d","progress":"e","next":"f"}')}结尾`
    )
    expect(stripped).toBe('第一段中间结尾')
  })
})

describe('hasTaskStatusBlock', () => {
  it('detects the marker', () => {
    expect(hasTaskStatusBlock(BLOCK('{}'))).toBe(true)
    expect(hasTaskStatusBlock('没有')).toBe(false)
  })
})
