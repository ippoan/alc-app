import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const dev = vi.hoisted(() => ({ on: true }))
vi.mock('~/utils/token-selection', () => ({ isDevDevice: () => dev.on }))

import { devTiming, resetDevTimingClock, DEV_TIMING_MAX_LINES, DEV_TIMING_STORAGE_KEY } from '~/utils/dev-timing'

function stored(): string[] {
  return JSON.parse(sessionStorage.getItem(DEV_TIMING_STORAGE_KEY) ?? '[]')
}

describe('devTiming', () => {
  let info: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dev.on = true
    sessionStorage.clear()
    resetDevTimingClock()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 21, 9, 5, 7, 42))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('開発用の端末では時刻・前回からの ms・label・detail を console と sessionStorage に出す', () => {
    devTiming('bp.step', { step: 'measure' })
    vi.advanceTimersByTime(1500)
    devTiming('bp.save.begin')

    expect(info).toHaveBeenNthCalledWith(1, '[DEV-TIMING] 09:05:07.042 +0ms bp.step step=measure')
    expect(info).toHaveBeenNthCalledWith(2, '[DEV-TIMING] 09:05:08.542 +1500ms bp.save.begin')
    expect(stored()).toEqual([
      '[DEV-TIMING] 09:05:07.042 +0ms bp.step step=measure',
      '[DEV-TIMING] 09:05:08.542 +1500ms bp.save.begin',
    ])
  })

  it('本番の端末では何も出さず、何も積まない', () => {
    dev.on = false
    devTiming('bp.step', { step: 'measure' })
    expect(info).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(DEV_TIMING_STORAGE_KEY)).toBeNull()
  })

  it('sessionStorage は直近 300 行の輪で切れる', () => {
    for (let i = 0; i < DEV_TIMING_MAX_LINES + 5; i++) devTiming('tick', { i })
    const lines = stored()
    expect(lines).toHaveLength(DEV_TIMING_MAX_LINES)
    expect(lines[0]).toContain('i=5')
    expect(lines[lines.length - 1]).toContain(`i=${DEV_TIMING_MAX_LINES + 4}`)
  })

  it('sessionStorage が例外でも落ちず、console には出る', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => devTiming('x')).not.toThrow()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('壊れた中身が入っていても落ちない', () => {
    sessionStorage.setItem(DEV_TIMING_STORAGE_KEY, '{not json')
    expect(() => devTiming('x')).not.toThrow()
  })
})
