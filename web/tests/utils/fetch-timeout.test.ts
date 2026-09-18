// fetch-timeout.ts — fetch に上限を載せる共通ヘルパー (Refs ippoan/alc-app#338)
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  withTimeout, asTimeoutError, fetchWithTimeout, timeoutMessageFor,
  DEFAULT_FETCH_TIMEOUT_MS, UPLOAD_FETCH_TIMEOUT_MS, AUTH_WORKER_FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_MESSAGE_READ, FETCH_TIMEOUT_MESSAGE_WRITE,
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

// 本番でハングした回は POST が**サーバに届いて成功していた**。押し直させると
// 宙ぶらりんの点呼セッションが増えるので、書き込みでは再試行を促さない
// (Refs ippoan/alc-app#338)。
describe('timeoutMessageFor', () => {
  it.each(['GET', 'HEAD', 'get'])('%s は押し直してよいと書く', (method) => {
    expect(timeoutMessageFor(method)).toBe(FETCH_TIMEOUT_MESSAGE_READ)
  })

  it('method 未指定は GET 扱い', () => {
    expect(timeoutMessageFor()).toBe(FETCH_TIMEOUT_MESSAGE_READ)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('%s は再試行を促さない', (method) => {
    expect(timeoutMessageFor(method)).toBe(FETCH_TIMEOUT_MESSAGE_WRITE)
  })

  it('書き込みの文言には「もう一度」が入らず、次の行動 2 つが入る', () => {
    // 押し直させない — サーバ側では成功していることがある
    expect(FETCH_TIMEOUT_MESSAGE_WRITE).not.toContain('もう一度')
    expect(FETCH_TIMEOUT_MESSAGE_WRITE).toContain('同じ操作を繰り返さず')
    // 何が起きたか + 次にやること
    expect(FETCH_TIMEOUT_MESSAGE_WRITE).toContain('完了している可能性があります')
    expect(FETCH_TIMEOUT_MESSAGE_WRITE).toContain('画面を確認する')
    expect(FETCH_TIMEOUT_MESSAGE_WRITE).toContain('運行管理者に連絡してください')
  })
})

describe('asTimeoutError', () => {
  it('TimeoutError は次の行動が書いてある文言に置き換える (既定 = 読み取り)', () => {
    const out = asTimeoutError(timeoutError())
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toBe(FETCH_TIMEOUT_MESSAGE_READ)
  })

  it('method を渡せば書き込み用の文言になる', () => {
    expect((asTimeoutError(timeoutError(), 'POST') as Error).message).toBe(FETCH_TIMEOUT_MESSAGE_WRITE)
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
    await expect(fetchWithTimeout('/api/x')).rejects.toThrow(FETCH_TIMEOUT_MESSAGE_READ)
  })

  it('書き込みの timeout は init.method を見て再試行を促さない文言になる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError()))
    await expect(fetchWithTimeout('/api/x', { method: 'POST' })).rejects.toThrow(FETCH_TIMEOUT_MESSAGE_WRITE)
  })

  it('timeout 以外の失敗はそのまま投げる', async () => {
    const e = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(e))
    await expect(fetchWithTimeout('/api/x')).rejects.toBe(e)
  })
})
