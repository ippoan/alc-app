// fetch-timeout.ts — fetch に上限を載せる共通ヘルパー (Refs ippoan/alc-app#338)
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  withTimeout, asTimeoutError, fetchWithTimeout,
  DEFAULT_FETCH_TIMEOUT_MS, UPLOAD_FETCH_TIMEOUT_MS, AUTH_WORKER_FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_MESSAGE,
} from '~/utils/fetch-timeout'

/** `AbortSignal.timeout()` が発火したときの失敗と同じ形 (name だけで判定している)。 */
function timeoutError(): Error {
  const e = new Error('signal timed out')
  e.name = 'TimeoutError'
  return e
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('定数', () => {
  it('既定 < アップロードの順で、共有経路を落とさない長さになっている', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000)
    expect(UPLOAD_FETCH_TIMEOUT_MS).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS)
    // AUTH SIGNBP / AUTH SIGN の 10 秒と揃える (非対称の解消)
    expect(AUTH_WORKER_FETCH_TIMEOUT_MS).toBe(10_000)
  })
})

describe('withTimeout', () => {
  it('signal が無ければ AbortSignal.timeout を載せる (元の init は変更しない)', () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const init: RequestInit = { method: 'POST' }
    const out = withTimeout(init)

    expect(spy).toHaveBeenCalledWith(DEFAULT_FETCH_TIMEOUT_MS)
    expect(out.method).toBe('POST')
    expect(out.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal).toBeUndefined()
  })

  it('ms を渡せば別枠の長さになる', () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    withTimeout({} as RequestInit, UPLOAD_FETCH_TIMEOUT_MS)
    expect(spy).toHaveBeenCalledWith(UPLOAD_FETCH_TIMEOUT_MS)
  })

  it('呼び出し側が signal を渡していれば上書きしない', () => {
    const ac = new AbortController()
    const init: RequestInit = { signal: ac.signal }
    expect(withTimeout(init)).toBe(init)
    expect(init.signal).toBe(ac.signal)
  })

  it('載せた signal は指定の時間で TimeoutError として発火する', async () => {
    const { signal } = withTimeout({} as RequestInit, 1)
    await new Promise(r => setTimeout(r, 30))
    expect(signal!.aborted).toBe(true)
    expect((signal!.reason as Error).name).toBe('TimeoutError')
  })
})

describe('asTimeoutError', () => {
  it('TimeoutError は次の行動が書いてある文言に置き換える', () => {
    const out = asTimeoutError(timeoutError())
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toBe(FETCH_TIMEOUT_MESSAGE)
  })

  it('それ以外の Error はそのまま返す', () => {
    const e = new Error('API エラー (500): boom')
    expect(asTimeoutError(e)).toBe(e)
  })

  it('Error でない値もそのまま返す', () => {
    expect(asTimeoutError('boom')).toBe('boom')
  })
})

describe('fetchWithTimeout', () => {
  it('成功時は Response をそのまま返し、signal を載せて呼ぶ', async () => {
    const res = { ok: true, status: 200 }
    const fetchMock = vi.fn().mockResolvedValue(res)
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchWithTimeout('/api/x', { method: 'GET' })).toBe(res)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/x')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('init 省略でも signal が載る', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await fetchWithTimeout('/api/x')
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('ms を渡せばその長さで載る', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    await fetchWithTimeout('/api/x', {}, AUTH_WORKER_FETCH_TIMEOUT_MS)
    expect(spy).toHaveBeenCalledWith(AUTH_WORKER_FETCH_TIMEOUT_MS)
  })

  it('timeout したら文言にして reject する (無言で止まらない)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()))
    await expect(fetchWithTimeout('/api/x')).rejects.toThrow(FETCH_TIMEOUT_MESSAGE)
  })

  it('timeout 以外の失敗はそのまま投げる', async () => {
    const e = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(e))
    await expect(fetchWithTimeout('/api/x')).rejects.toBe(e)
  })
})
