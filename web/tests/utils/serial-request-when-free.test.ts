import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isPortBusy, requestWhenFree } from '~/utils/serial-request-when-free'

const BUSY = new Error('request(timecard): 既に応答待ちです')

describe('isPortBusy', () => {
  it('「既に応答待ちです」を含む reject だけ true', () => {
    expect(isPortBusy(BUSY)).toBe(true)
    expect(isPortBusy(new Error('timeout'))).toBe(false)
  })
})

describe('requestWhenFree', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('弾かれなければそのまま返す', async () => {
    const send = vi.fn(async () => 'OK')
    await expect(requestWhenFree(send, { intervalMs: 100 })).resolves.toBe('OK')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('弾かれたときだけ間を置いて呼び直す', async () => {
    const send = vi.fn().mockRejectedValueOnce(BUSY).mockResolvedValueOnce('OK')
    const p = requestWhenFree(send, { intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBe('OK')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('弾く以外の失敗は呼び直さない', async () => {
    const send = vi.fn().mockRejectedValue(new Error('timeout'))
    await expect(requestWhenFree(send, { intervalMs: 100 })).rejects.toThrow('timeout')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('maxRetries を超えたら最後のエラーを投げる', async () => {
    const send = vi.fn().mockRejectedValue(BUSY)
    const p = requestWhenFree(send, { intervalMs: 100, maxRetries: 2 })
    const assertion = expect(p).rejects.toThrow('既に応答待ちです')
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('deadline を超えるなら呼び直さず giveUp のエラーを投げる', async () => {
    const send = vi.fn().mockRejectedValue(BUSY)
    const p = requestWhenFree(send, {
      intervalMs: 100,
      deadline: Date.now() + 250,
      giveUp: e => new Error(`gave up: ${e.message}`),
    })
    const assertion = expect(p).rejects.toThrow('gave up: request(timecard): 既に応答待ちです')
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('待ったあとに isCancelled なら呼び直さない', async () => {
    let cancelled = false
    const send = vi.fn().mockRejectedValue(BUSY)
    const p = requestWhenFree(send, { intervalMs: 100, isCancelled: () => cancelled })
    const assertion = expect(p).rejects.toThrow('既に応答待ちです')
    cancelled = true
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(send).toHaveBeenCalledTimes(1)
  })
})
