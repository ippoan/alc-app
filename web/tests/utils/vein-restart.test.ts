// 画面から Vein Station を再起動し、機体の起動を待ってからページを読み込み直す
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { restartVeinAndReload, veinRestartReload, VEIN_RESTART_RELOAD_MS } from '~/utils/vein-restart'

describe('restartVeinAndReload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    veinRestartReload.run = vi.fn()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('★ 再起動を頼み、起動を待ってからページを読み込み直す', async () => {
    const restart = vi.fn(async () => {})
    await restartVeinAndReload(restart)
    expect(restart).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(VEIN_RESTART_RELOAD_MS - 1)
    expect(veinRestartReload.run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(veinRestartReload.run).toHaveBeenCalledTimes(1)
  })

  it('頼めなければ投げて、読み込み直さない', async () => {
    await expect(restartVeinAndReload(async () => {
      throw new Error('Vein Station がつながっていません')
    })).rejects.toThrow('つながっていません')
    vi.advanceTimersByTime(VEIN_RESTART_RELOAD_MS)
    expect(veinRestartReload.run).not.toHaveBeenCalled()
  })
})
