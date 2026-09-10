import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import {
  deviceLoginNoKeyMessage,
  deviceLoginParseFailedMessage,
  deviceLoginTimeoutMessage,
} from '~/utils/device-login-messages'

/**
 * useDeviceLogin (#214 警告デバイス認証) のテスト。
 *
 * useAlarmDevice / getAuthCallbackUrl (useAuth) は mock する — 警告デバイスの接続そのもの
 * は useAlarmDevice.test.ts が担保済みで、ここでは「nonce 取得 → AUTH SIGN → device-login
 * 遷移」の組み立てだけを見る。redirect_uri の出どころが 1 か所であることも
 * getAuthCallbackUrl の呼び出し回数で確かめる。
 */

const authMock = vi.hoisted(() => ({
  getAuthCallbackUrl: vi.fn(() => 'https://kiosk.example.com/auth/callback'),
}))
vi.mock('~/composables/useAuth', () => authMock)

const alarmDeviceMock = vi.hoisted(() => ({
  request: vi.fn(),
}))
mockNuxtImport('useAlarmDevice', () => () => alarmDeviceMock)

/** XMLHttpRequest の最小モック。send() は何もせず、テストから onload/onerror を手動で起こす */
class MockXHR {
  static instances: MockXHR[] = []
  method = ''
  url = ''
  status = 0
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    MockXHR.instances.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  send(): void { /* テストが respondNonce()/respondNonceError() で手動応答する */ }
}

function lastXhr(): MockXHR {
  const xhr = MockXHR.instances.at(-1)
  if (!xhr) throw new Error('XHR が送られていません')
  return xhr
}

function respondNonce(status: number, body: unknown): void {
  const xhr = lastXhr()
  xhr.status = status
  xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body)
  xhr.onload?.()
}

function respondNonceError(): void {
  lastXhr().onerror?.()
}

describe('useDeviceLogin', () => {
  let hrefSetter: ReturnType<typeof vi.fn>
  let originalLocation: Location

  beforeEach(async () => {
    vi.clearAllMocks()
    authMock.getAuthCallbackUrl.mockReturnValue('https://kiosk.example.com/auth/callback')
    MockXHR.instances = []
    vi.stubGlobal('XMLHttpRequest', MockXHR as unknown as typeof XMLHttpRequest)

    hrefSetter = vi.fn()
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: {
        ...originalLocation,
        origin: 'https://kiosk.example.com',
        href: '',
        set href(val: string) { hrefSetter(val) },
      },
      writable: true,
      configurable: true,
    })

    // module-level state (lastError/busy/loggingIn) を毎回まっさらにする
    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
    vi.unstubAllGlobals()
  })

  async function loadDeviceLogin() {
    const mod = await import('~/composables/useDeviceLogin')
    return mod.useDeviceLogin()
  }

  // ---------- 成功 ----------

  it('成功: nonce取得 → AUTH SIGN → device-login へ top-level navigate する', async () => {
    alarmDeviceMock.request.mockResolvedValue('AUTH SIG pub-1 sig-1')
    const { login, lastError, busy } = await loadDeviceLogin()

    const p = login()
    expect(busy.value).toBe(true)
    respondNonce(200, { nonce: 'nonce-abc', expires_in: 60 })
    await p

    // redirect_uri は 1 回だけ取得して nonce 取得と device-login の両方で使う
    expect(authMock.getAuthCallbackUrl).toHaveBeenCalledTimes(1)

    expect(lastXhr().method).toBe('GET')
    expect(lastXhr().url).toContain('/auth/device-nonce?redirect_uri=')
    expect(lastXhr().url).toContain(encodeURIComponent('https://kiosk.example.com/auth/callback'))

    expect(alarmDeviceMock.request).toHaveBeenCalledWith('AUTH SIGN nonce-abc', 'AUTH SIG ', 10_000)

    const url = hrefSetter.mock.calls[0]?.[0] as string
    expect(url).toContain('/auth/device-login?')
    expect(url).toContain('pubkey=pub-1')
    expect(url).toContain('nonce=nonce-abc')
    expect(url).toContain('sig=sig-1')
    expect(url).toContain(`redirect_uri=${encodeURIComponent('https://kiosk.example.com/auth/callback')}`)

    expect(lastError.value).toBeNull()
    expect(busy.value).toBe(false)
  })

  it('二重起動を防ぐ (呼び出し中の 2 回目は何もしない)', async () => {
    alarmDeviceMock.request.mockResolvedValue('AUTH SIG pub-1 sig-1')
    const { login } = await loadDeviceLogin()

    const p1 = login()
    const p2 = login()
    expect(MockXHR.instances.length).toBe(1)

    respondNonce(200, { nonce: 'nonce-abc' })
    await p1
    await p2
  })

  // ---------- nonce 取得失敗 ----------

  describe('nonce 取得失敗', () => {
    it('http エラー (2xx 以外)', async () => {
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(500, '')
      await p
      expect(lastError.value).toContain('http 500')
      expect(alarmDeviceMock.request).not.toHaveBeenCalled()
    })

    it('応答を JSON として解釈できない', async () => {
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(200, 'not-json{')
      await p
      expect(lastError.value).toContain('JSON')
    })

    it('応答に nonce が含まれない', async () => {
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(200, { expires_in: 60 })
      await p
      expect(lastError.value).toContain('nonce')
    })

    it('通信エラー (onerror)', async () => {
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonceError()
      await p
      expect(lastError.value).toContain('通信エラー')
    })
  })

  // ---------- ERR AUTH: no key ----------

  it('ERR AUTH: no key → 鍵登録を促す文言', async () => {
    alarmDeviceMock.request.mockRejectedValue(new Error('ERR AUTH: no key'))
    const { login, lastError } = await loadDeviceLogin()
    const p = login()
    respondNonce(200, { nonce: 'nonce-abc' })
    await p
    expect(lastError.value).toBe(deviceLoginNoKeyMessage)
  })

  // ---------- タイムアウト (no key 以外の reject 理由すべて) ----------

  it('タイムアウト (no key 以外の reject) → 汎用メッセージ', async () => {
    alarmDeviceMock.request.mockRejectedValue(
      new Error('request(alarm-device): timeout waiting for "AUTH SIG "'),
    )
    const { login, lastError } = await loadDeviceLogin()
    const p = login()
    respondNonce(200, { nonce: 'nonce-abc' })
    await p
    expect(lastError.value).toBe(deviceLoginTimeoutMessage)
  })

  it('Error インスタンスでない reject でも落ちない (useHubClaim と同じ防御)', async () => {
    alarmDeviceMock.request.mockRejectedValue('boom')
    const { login, lastError } = await loadDeviceLogin()
    const p = login()
    respondNonce(200, { nonce: 'nonce-abc' })
    await p
    expect(lastError.value).toBe(deviceLoginTimeoutMessage)
  })

  // ---------- 応答 parse 失敗 ----------

  describe('応答 parse 失敗', () => {
    it('トークン数が想定 (4) と違う', async () => {
      alarmDeviceMock.request.mockResolvedValue('AUTH SIG pubonly')
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(200, { nonce: 'nonce-abc' })
      await p
      expect(lastError.value).toBe(deviceLoginParseFailedMessage)
    })

    it('先頭トークンが AUTH でない', async () => {
      alarmDeviceMock.request.mockResolvedValue('XXXX SIG pub-1 sig-1')
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(200, { nonce: 'nonce-abc' })
      await p
      expect(lastError.value).toBe(deviceLoginParseFailedMessage)
    })

    it('2番目のトークンが SIG でない', async () => {
      alarmDeviceMock.request.mockResolvedValue('AUTH XXX pub-1 sig-1')
      const { login, lastError } = await loadDeviceLogin()
      const p = login()
      respondNonce(200, { nonce: 'nonce-abc' })
      await p
      expect(lastError.value).toBe(deviceLoginParseFailedMessage)
    })
  })
})
