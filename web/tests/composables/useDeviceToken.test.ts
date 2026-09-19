import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// useDeviceToken はモジュールスコープに credential ref + JWT cache を持つ
// シングルトンなので、テスト毎に resetModules + dynamic import で分離する。
type Mod = typeof import('~/composables/useDeviceToken')

async function load(): Promise<Mod['useDeviceToken']> {
  const mod = await import('~/composables/useDeviceToken')
  return mod.useDeviceToken
}

const ID = 'dev-abc'
const SECRET = 'sec-xyz'

// CoreS3 の署名経路 (#234-2、旧 #231 は警告デバイス宛てだった) 用のモック。
// useCoreS3Serial / useAuth は Nuxt auto-import なので mockNuxtImport、
// signAlarmDeviceNonce は useDeviceToken.ts が明示 import するので vi.mock で差し替える。
const coreS3Mock = vi.hoisted(() => ({
  isSupported: true as boolean,
  isConnected: { value: false },
  request: vi.fn(),
  onClose: vi.fn(),
  // 起動時の探索 (Refs #238)。既定は「繋がらなかった」
  startupProbe: vi.fn(async () => false),
}))
mockNuxtImport('useCoreS3Serial', () => () => coreS3Mock)

// 警告デバイス (VoiceS3R) には AUTH SIGN を送らないことを確かめるための spy。
// useDeviceToken.ts は #234-2 で useAlarmDevice への依存を消したので、これが
// 呼ばれることは無いはず
const alarmDeviceRequestMock = vi.hoisted(() => vi.fn())
mockNuxtImport('useAlarmDevice', () => () => ({ isConnected: { value: false }, request: alarmDeviceRequestMock }))

const authMock = vi.hoisted(() => ({ deviceTenantId: { value: null as string | null } }))
mockNuxtImport('useAuth', () => () => authMock)

const signAlarmDeviceNonceMock = vi.hoisted(() => vi.fn())
vi.mock('~/utils/alarm-sign', () => ({
  signAlarmDeviceNonce: signAlarmDeviceNonceMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.resetModules()
  localStorage.clear()
  coreS3Mock.isSupported = true
  coreS3Mock.isConnected.value = false
  coreS3Mock.request.mockReset()
  coreS3Mock.onClose.mockReset()
  coreS3Mock.startupProbe.mockReset()
  coreS3Mock.startupProbe.mockImplementation(async () => false)
  authMock.deviceTenantId.value = null
  signAlarmDeviceNonceMock.mockReset()
  // #135 で失敗・成功のたびに 1 行出るようになったので、既定では捨てる
  // (中身を見るテストは各自で spy を取り直す)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

/** console.warn / info / log / error に出た全行を 1 本の文字列で返す (#135 診断用) */
function consoleSink() {
  const lines: string[] = []
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  vi.spyOn(console, 'warn').mockImplementation(push)
  vi.spyOn(console, 'info').mockImplementation(push)
  vi.spyOn(console, 'log').mockImplementation(push)
  vi.spyOn(console, 'error').mockImplementation(push)
  return { text: () => lines.join('\n'), lines }
}

describe('useDeviceToken (#434 step 3c)', () => {
  it('credential 未保存なら hasKioskCredential=false / getDeviceJwt=null (fetch しない)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { hasKioskCredential, getDeviceJwt } = useDeviceToken()

    expect(hasKioskCredential.value).toBe(false)
    expect(await getDeviceJwt()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('storeKioskCredential で localStorage に保存し hasKioskCredential=true', async () => {
    const useDeviceToken = await load()
    const { storeKioskCredential, hasKioskCredential } = useDeviceToken()

    storeKioskCredential(ID, SECRET)

    expect(hasKioskCredential.value).toBe(true)
    expect(localStorage.getItem('alc_kiosk_device_id')).toBe(ID)
    expect(localStorage.getItem('alc_kiosk_device_secret')).toBe(SECRET)
  })

  it('起動時に localStorage から credential を復元する', async () => {
    localStorage.setItem('alc_kiosk_device_id', ID)
    localStorage.setItem('alc_kiosk_device_secret', SECRET)

    const useDeviceToken = await load()
    expect(useDeviceToken().hasKioskCredential.value).toBe(true)
  })

  it('getDeviceJwt は /device/token を叩いて access_token を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'jwt-1', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)

    expect(await getDeviceJwt()).toBe('jwt-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://auth.ippoan.org/device/token')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ device_id: ID, device_secret: SECRET })
  })

  it('cache が効く (有効期限内は再 mint しない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'jwt-1', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)

    await getDeviceJwt()
    await getDeviceJwt()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('expires_in 欠落時も fallback TTL で cache する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'jwt-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)

    expect(await getDeviceJwt()).toBe('jwt-1')
    await getDeviceJwt()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('non-2xx は null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)
    expect(await getDeviceJwt()).toBeNull()
  })

  it('access_token 欠落は null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ expires_in: 10 }) }))
    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)
    expect(await getDeviceJwt()).toBeNull()
  })

  it('fetch throw は null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)
    expect(await getDeviceJwt()).toBeNull()
  })

  it('clearKioskCredential で credential + cache を破棄', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'jwt-1', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, clearKioskCredential, getDeviceJwt, hasKioskCredential } = useDeviceToken()
    storeKioskCredential(ID, SECRET)
    await getDeviceJwt()

    clearKioskCredential()

    expect(hasKioskCredential.value).toBe(false)
    expect(localStorage.getItem('alc_kiosk_device_id')).toBeNull()
    expect(await getDeviceJwt()).toBeNull()
  })

  describe('pairKioskDevice (管理者側 /device/pair)', () => {
    it('adminToken 空は fetch せず null', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const useDeviceToken = await load()
      expect(await useDeviceToken().pairKioskDevice('', 'kiosk-1')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('role=device-kiosk で発行し credential を返す', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ device_id: 'd1', device_secret: 's1' }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const useDeviceToken = await load()
      const cred = await useDeviceToken().pairKioskDevice('admin-jwt', 'kiosk-1')

      expect(cred).toEqual({ device_id: 'd1', device_secret: 's1' })
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://auth.ippoan.org/device/pair')
      expect(init.headers.Authorization).toBe('Bearer admin-jwt')
      expect(JSON.parse(init.body)).toEqual({ label: 'kiosk-1', role: 'device-kiosk' })
    })

    it('non-2xx は null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
      const useDeviceToken = await load()
      expect(await useDeviceToken().pairKioskDevice('admin-jwt', 'k')).toBeNull()
    })

    it('device_id / device_secret 欠落は null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ device_id: 'd1' }) }))
      const useDeviceToken = await load()
      expect(await useDeviceToken().pairKioskDevice('admin-jwt', 'k')).toBeNull()
    })

    it('fetch throw は null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')))
      const useDeviceToken = await load()
      expect(await useDeviceToken().pairKioskDevice('admin-jwt', 'k')).toBeNull()
    })
  })

  describe('setupAsKiosk (self-pair)', () => {
    it('成功すると credential を発行・保存して true', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ device_id: 'd1', device_secret: 's1' }),
      }))
      const useDeviceToken = await load()
      const { setupAsKiosk, hasKioskCredential } = useDeviceToken()

      expect(await setupAsKiosk('admin-jwt', 'kiosk-1')).toBe(true)
      expect(hasKioskCredential.value).toBe(true)
      expect(localStorage.getItem('alc_kiosk_device_id')).toBe('d1')
      expect(localStorage.getItem('alc_kiosk_device_secret')).toBe('s1')
    })

    it('pairing 失敗時は false で credential を保存しない', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
      const useDeviceToken = await load()
      const { setupAsKiosk, hasKioskCredential } = useDeviceToken()

      expect(await setupAsKiosk('admin-jwt', 'kiosk-1')).toBe(false)
      expect(hasKioskCredential.value).toBe(false)
      expect(localStorage.getItem('alc_kiosk_device_id')).toBeNull()
    })
  })

  describe('getDeviceJwt: CoreS3 の署名による短命端末 JWT (#234-2、旧 #231 は警告デバイス宛てだった)', () => {
    /** URL の末尾 (パス) で振り分ける fetch mock。想定外の URL は throw して見逃しを防ぐ。 */
    function routeFetch(handlers: Record<string, () => { ok: boolean, status?: number, json: () => Promise<unknown> }>) {
      return vi.fn((url: string) => {
        for (const [suffix, handler] of Object.entries(handlers)) {
          if (url.endsWith(suffix)) return Promise.resolve(handler())
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
    }

    it('CoreS3 接続中なら credential より優先し、alarm-nonce → AUTH SIGN → alarm-token で取って cache する (CoreS3.request 宛てに送る)', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
      storeKioskCredential(ID, SECRET) // credential も持っているが使われないはず

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(signAlarmDeviceNonceMock).toHaveBeenCalledWith('n1', coreS3Mock.request)
      expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('/device/token'))).toBe(false)
      // 警告デバイス (VoiceS3R) には送らない
      expect(alarmDeviceRequestMock).not.toHaveBeenCalled()
    })

    it('S3R の JWT は既存キャッシュに載り、期限前は再利用する (再 fetch しない)', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(fetchMock).toHaveBeenCalledTimes(2) // nonce + token が 1 回ずつ
      expect(signAlarmDeviceNonceMock).toHaveBeenCalledTimes(1)
    })

    it('single-flight: 同時 3 回呼んでも nonce の取得は 1 回だけ', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      let nonceCalls = 0
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) {
          nonceCalls += 1
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) })
        }
        if (url.endsWith('/device/alarm-token')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      const results = await Promise.all([getDeviceJwt(), getDeviceJwt(), getDeviceJwt()])
      expect(results).toEqual(['s3r-jwt', 's3r-jwt', 's3r-jwt'])
      expect(nonceCalls).toBe(1)
    })

    it('CoreS3 未接続なら nonce を呼ばず、既存の credential 経路だけを試す', async () => {
      coreS3Mock.isConnected.value = false
      coreS3Mock.startupProbe.mockImplementation(async () => false)
      const fetchMock = routeFetch({
        '/device/token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 'cred-jwt', expires_in: 3600 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
      storeKioskCredential(ID, SECRET)

      expect(await getDeviceJwt()).toBe('cred-jwt')
      expect(coreS3Mock.startupProbe).toHaveBeenCalledTimes(1)
      expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('alarm-nonce'))).toBe(false)
    })

    it('未接続でも起動時の探索で繋がれば (true)、CoreS3 の署名で JWT を取る (Refs #238)', async () => {
      coreS3Mock.isConnected.value = false
      coreS3Mock.startupProbe.mockImplementation(async () => {
        coreS3Mock.isConnected.value = true
        return true
      })
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      vi.stubGlobal('fetch', routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      }))

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(coreS3Mock.startupProbe).toHaveBeenCalledTimes(1)
      expect(signAlarmDeviceNonceMock).toHaveBeenCalledWith('n1', coreS3Mock.request)
    })

    it('探索が false なら null (credential 無し)。抑止も lastError も立てない', async () => {
      coreS3Mock.isConnected.value = false
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt, lastError } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(lastError.value).toBeNull()
    })

    it('探索が true でも、その後に抜かれて未接続なら署名を頼まず null', async () => {
      coreS3Mock.isConnected.value = false
      coreS3Mock.startupProbe.mockImplementation(async () => true)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt, lastError } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
      expect(lastError.value).toBeNull()
    })

    it('待つのは起動時の 1 本の 3 秒だけ — 2 回目以降は解決済みの 1 本を見て即 null', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        coreS3Mock.isConnected.value = false
        // 実体と同じく「1 本を共有する」探索: 3 秒で false に解決する
        let probe: Promise<boolean> | null = null
        coreS3Mock.startupProbe.mockImplementation(() => {
          probe ??= new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))
          return probe
        })
        vi.stubGlobal('fetch', vi.fn())

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        let firstDone = false
        const first = getDeviceJwt().finally(() => { firstDone = true })
        await vi.advanceTimersByTimeAsync(2999)
        expect(firstDone).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await expect(first).resolves.toBeNull()

        let secondDone = false
        const second = getDeviceJwt().finally(() => { secondDone = true })
        // タイマーを進めずに解決する (新たに 3 秒待たない)
        await vi.advanceTimersByTimeAsync(0)
        expect(secondDone).toBe(true)
        await expect(second).resolves.toBeNull()
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('S3R が 401/429 で失敗すれば null に落ちて credential 経路を試す', async () => {
      coreS3Mock.isConnected.value = true
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: false, status: 429, json: () => Promise.resolve({}) }),
        '/device/token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 'cred-jwt', expires_in: 3600 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
      storeKioskCredential(ID, SECRET)

      expect(await getDeviceJwt()).toBe('cred-jwt')
      expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
    })

    it('AUTH SIGN が ERR AUTH: no key で reject すると即失敗し (タイムアウトを待たない) lastError に理由を残す (credential 未保存なら null)', async () => {
      coreS3Mock.isConnected.value = true
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)
      signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))

      const useDeviceToken = await load()
      const { getDeviceJwt, lastError } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(lastError.value).toContain('ERR AUTH: no key')
    })

    it('alarm-nonce の応答に nonce が無ければ null に落ちる', async () => {
      coreS3Mock.isConnected.value = true
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ expires_in: 60 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
    })

    it('AUTH SIG の parse に失敗 (signAlarmDeviceNonce が null を返す) は null に落ちる', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue(null)
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
    })

    it('alarm-token が 401 {error:"invalid_alarm_token"} なら (body を見ず status だけで) null に落ちる (nonce 取得・署名は成功していても)', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_alarm_token' }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
    })

    it('alarm-token の応答に access_token が無ければ null に落ちる', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
    })

    it('alarm-token の expires_in 欠落時は fallback TTL (900 秒) で cache する', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt' }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(await getDeviceJwt()).toBe('s3r-jwt') // fallback TTL でも cache が効く
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('alarm-token の応答に tenant_id が無ければ warn しない', async () => {
      coreS3Mock.isConnected.value = true
      authMock.deviceTenantId.value = 'tenant-A'
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', token_type: 'Bearer', expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('S3R 失敗後 60 秒は nonce を呼ばず (credential 無しなら null、lastError は保持)、61 秒後は再試行する', async () => {
      coreS3Mock.isConnected.value = true
      let nowMs = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

      const nonceMock = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }))
      vi.stubGlobal('fetch', nonceMock)

      const useDeviceToken = await load()
      const { getDeviceJwt, lastError } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(nonceMock).toHaveBeenCalledTimes(1)
      expect(lastError.value).toContain('alarm-nonce')

      nowMs += 59_000 // 59 秒後: まだ抑止期間中
      expect(await getDeviceJwt()).toBeNull()
      expect(nonceMock).toHaveBeenCalledTimes(1)
      expect(lastError.value).toContain('alarm-nonce') // 抑止中は理由を保持したまま

      nowMs += 2_000 // 61 秒後: 抑止解除、再試行する
      expect(await getDeviceJwt()).toBeNull()
      expect(nonceMock).toHaveBeenCalledTimes(2)
    })

    // 食い違いの出し分け (Refs ippoan/rust-alc-api#644)。
    // **未設定との食い違いは平常運転**なので警告にしない — 常時鳴ると読み飛ばす習慣がつき、
    // 本物の異常 (テナントをまたいだトークン) が埋もれる。

    it('★ 端末未登録 (deviceTenantId が未設定) なら warn を出さない — 共用 PC の平常運転', async () => {
      coreS3Mock.isConnected.value = true
      authMock.deviceTenantId.value = null
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })

      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({
          ok: true,
          json: () => Promise.resolve({ access_token: 's3r-jwt', token_type: 'Bearer', expires_in: 900, tenant_id: 'tenant-X' }),
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      // **拒否はしない** (発行元の判断を尊重する既存の設計は変えていない)
      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(warnSpy).not.toHaveBeenCalled()
      expect(debugSpy).toHaveBeenCalledTimes(1)
    })

    it('★ 登録先と発行元が食い違うときだけ warn を出す (テナントをまたいだトークン = 異常)', async () => {
      coreS3Mock.isConnected.value = true
      authMock.deviceTenantId.value = 'tenant-A'
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })

      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({
          ok: true,
          json: () => Promise.resolve({ access_token: 's3r-jwt', token_type: 'Bearer', expires_in: 900, tenant_id: 'tenant-B' }),
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      // 「どちらがどちら」が読み取れる文面にしておく
      expect(String(warnSpy.mock.calls[0]![0])).toContain('登録先と発行元が食い違っています')
    })

    it('alarm-token 応答の tenant_id が deviceTenantId と食い違っても拒否せず warn だけ (#552)', async () => {
      coreS3Mock.isConnected.value = true
      authMock.deviceTenantId.value = 'tenant-A'
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })

      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({
          ok: true,
          json: () => Promise.resolve({ access_token: 's3r-jwt', token_type: 'Bearer', expires_in: 900, tenant_id: 'tenant-B' }),
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('S3R 経路は localStorage / sessionStorage に一切書かない', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

      const useDeviceToken = await load()
      const { getDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(setItemSpy).not.toHaveBeenCalled()
    })

    it('成功すると lastError が null に戻る (前回失敗が残っていても)', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockRejectedValueOnce(new Error('ERR AUTH: no key'))
      let nowMs = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
      const fetchMock = routeFetch({
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt, lastError } = useDeviceToken()

      expect(await getDeviceJwt()).toBeNull()
      expect(lastError.value).toContain('no key')

      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      nowMs += 61_000 // 抑止解除

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(lastError.value).toBeNull()
    })

    // 現地で「どの段で落ちたか」が読めるようにする診断 (Refs ippoan/alc-app-s3#135)。
    // 段と HTTP status を ref に残し、同じ内容を 1 行だけコンソールに出す。挙動は変えない。
    describe('lastFailureStage / コンソール診断 (Refs ippoan/alc-app-s3#135)', () => {
      it('nonce の取得に失敗したら段が nonce になる', async () => {
        coreS3Mock.isConnected.value = true
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: false, status: 503, json: () => Promise.resolve({ error: 'nonce_unavailable' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureStatus } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('nonce')
        expect(lastFailureStatus.value).toBe(503)
        expect(sink.text()).toContain('stage=nonce')
        expect(sink.text()).toContain('status=503')
        expect(sink.text()).toContain('code=nonce_unavailable')
      })

      it('CoreS3 の署名に失敗したら段が coreS3-sign になる', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureStatus } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('coreS3-sign')
        // HTTP を伴わない失敗なので status は無い
        expect(lastFailureStatus.value).toBeNull()
        expect(sink.text()).toContain('stage=coreS3-sign')
        expect(sink.text()).toContain('status=-')
      })

      it('alarm-token の交換が 401 なら段が token-exchange になり、エラーコードが残る', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
          '/device/alarm-token': () => ({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_alarm_token' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureStatus, lastError } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('token-exchange')
        expect(lastFailureStatus.value).toBe(401)
        expect(lastError.value).toContain('alarm-token http 401')
        expect(sink.text()).toContain('stage=token-exchange')
        expect(sink.text()).toContain('code=invalid_alarm_token')
      })

      it('サーバが error を返さない / body が JSON でない失敗は code=- になる', async () => {
        coreS3Mock.isConnected.value = true
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('nonce')
        expect(sink.text()).toContain('code=-')
        expect(sink.text()).toContain('status=502')
      })

      it('CoreS3 がつながっていなければ段は no-core-s3 (抑止も lastError も立てない)', async () => {
        coreS3Mock.isConnected.value = false
        const sink = consoleSink()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastError, coreS3BackoffUntil } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('no-core-s3')
        expect(lastError.value).toBeNull()
        expect(coreS3BackoffUntil.value).toBe(0)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(sink.text()).toContain('stage=no-core-s3')
      })

      it('抑止中の空振りは backoff として残り秒を出し、前回の段は保持する', async () => {
        coreS3Mock.isConnected.value = true
        let nowMs = 1_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: false, status: 429, json: () => Promise.resolve({}) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, coreS3BackoffUntil } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(coreS3BackoffUntil.value).toBe(nowMs + 60_000)

        nowMs += 20_000 // 抑止中
        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('nonce') // 前回の段は保持
        expect(sink.text()).toContain('stage=backoff')
        expect(sink.text()).toContain('backoff=40s')
      })

      it('成功したら段が null に戻り、console.info に経過 ms を出す', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureStatus } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(lastFailureStage.value).toBeNull()
        expect(lastFailureStatus.value).toBeNull()
        expect(infoSpy).toHaveBeenCalledTimes(1)
        expect(String(infoSpy.mock.calls[0]![0])).toMatch(/stage=ok elapsed=\d+ms/)
      })

      it('失敗の console にトークンや nonce が出ない', async () => {
        const NONCE = 'NONCE-must-not-leak'
        const PUBKEY = 'PUBKEY-must-not-leak'
        const SIG = 'SIG-must-not-leak'
        const TOKEN = 'TOKEN-must-not-leak'
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: PUBKEY, sig: SIG })
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: NONCE }) }),
          // 失敗応答にも token を載せておく (body をそのまま出していれば漏れる)
          '/device/alarm-token': () => ({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ error: 'invalid_alarm_token', access_token: TOKEN }),
          }),
        }))

        const useDeviceToken = await load()
        const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
        storeKioskCredential(ID, SECRET)

        expect(await getDeviceJwt()).toBeNull()
        const out = sink.text()
        expect(out).toContain('stage=token-exchange') // 診断自体は出ている
        for (const secret of [NONCE, PUBKEY, SIG, TOKEN, ID, SECRET]) {
          expect(out).not.toContain(secret)
          // 先頭 4 文字だけでも出さない
          expect(out).not.toContain(secret.slice(0, 4))
        }
      })
    })

    // ERR AUTH の理由の語を拾う (Refs ippoan/alc-app-s3#135 続報)。
    // 実測 (2026-09-16): USB も NFC も生きていたのに帯が消えず、原因は端末の鍵の未登録だった。
    // firmware は鍵が無ければ即座に `ERR AUTH: no key` を返す (console.ts)。この理由の語だけを
    // 拾って画面側 (banner) が「鍵が無い」を出し分けられるようにする。
    describe('lastFailureDetail (Refs ippoan/alc-app-s3#135 続報)', () => {
      it('coreS3-sign が ERR AUTH: no key で失敗したら lastFailureDetail が "no key" になる', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('coreS3-sign')
        expect(lastFailureDetail.value).toBe('no key')
      })

      it('coreS3-sign が ERR AUTH: bad nonce で失敗したら lastFailureDetail が "bad nonce" になる', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: bad nonce'))
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).toBe('bad nonce')
      })

      it('coreS3-sign が ERR AUTH 以外の理由 (parse 失敗) で失敗したら lastFailureDetail は null', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockResolvedValue(null) // parse 失敗 → 'AUTH SIG の parse に失敗'
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('coreS3-sign')
        expect(lastFailureDetail.value).toBeNull()
      })

      it('nonce / token-exchange 段の失敗では lastFailureDetail は null (coreS3-sign 専用)', async () => {
        coreS3Mock.isConnected.value = true
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: false, status: 503, json: () => Promise.resolve({}) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('nonce')
        expect(lastFailureDetail.value).toBeNull()
        expect(sink.text()).toContain('detail=-')
      })

      it('想定外に長い理由の語は切り詰める (画面が壊れないように)', async () => {
        coreS3Mock.isConnected.value = true
        const longSuffix = 'x'.repeat(200)
        signAlarmDeviceNonceMock.mockRejectedValue(new Error(`ERR AUTH: ${longSuffix}`))
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).not.toBeNull()
        expect(lastFailureDetail.value!.length).toBeLessThanOrEqual(40)
      })

      it('抑止中も直前の理由の語を保持する', async () => {
        coreS3Mock.isConnected.value = true
        let nowMs = 1_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).toBe('no key')

        nowMs += 20_000 // 抑止中
        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).toBe('no key') // 保持される
      })

      it('成功すると lastFailureDetail は null に戻る', async () => {
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockRejectedValueOnce(new Error('ERR AUTH: no key'))
        let nowMs = 1_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).toBe('no key')

        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        nowMs += 61_000 // 抑止解除

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(lastFailureDetail.value).toBeNull()
      })

      // 秘密が理由の語やコンソールに混ざらないことを assert する (渡した nonce・鍵・署名・
      // トークンの文字列が lastFailureDetail にもコンソールにも現れないことを確かめる)。
      // firmware (console.rs) の ERR AUTH 応答は 'no key' / 'bad nonce' のような固定語のみで、
      // 実際に使った nonce・鍵・署名・token を含まない。coreS3-sign 失敗と token-exchange 失敗の
      // 両方で、実際にやり取りした値がどこにも現れないことを確認する。
      it('理由の語に秘密が混ざらない (coreS3-sign 失敗): 実際の nonce・鍵・署名は現れない', async () => {
        const NONCE = 'NONCE-must-not-leak'
        coreS3Mock.isConnected.value = true
        // firmware は固定の理由語だけを返す (実際の nonce は含まない)
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: NONCE }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureDetail.value).toBe('no key')
        const out = sink.text()
        expect(lastFailureDetail.value ?? '').not.toContain(NONCE)
        expect(out).not.toContain(NONCE)
      })

      it('理由の語に秘密が混ざらない (token-exchange 失敗): 実際の nonce・鍵・署名・token は現れない', async () => {
        const NONCE = 'NONCE-must-not-leak'
        const PUBKEY = 'PUBKEY-must-not-leak'
        const SIG = 'SIG-must-not-leak'
        const TOKEN = 'TOKEN-must-not-leak'
        coreS3Mock.isConnected.value = true
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: PUBKEY, sig: SIG })
        const sink = consoleSink()
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: NONCE }) }),
          '/device/alarm-token': () => ({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ error: 'invalid_alarm_token', access_token: TOKEN }),
          }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        // token-exchange 段の失敗は coreS3-sign 専用の lastFailureDetail の対象外
        expect(lastFailureDetail.value).toBeNull()
        const out = sink.text()
        for (const secret of [NONCE, PUBKEY, SIG, TOKEN]) {
          expect(out).not.toContain(secret)
        }
      })
    })

    // AUTH SIGNBP でボンド状態を素通しする (#322-2、Refs ippoan/alc-app-s3#249)。
    // coreS3Mock.request は AUTH SIGN 系の実際の送信先 (signAlarmDeviceNonce はここでは
    // モックされているので呼ばれない)。SIGNBP は useDeviceToken.ts がこのモジュールに
    // 閉じて直接叩く経路なので、coreS3Mock.request を直接 mock する。
    describe('AUTH SIGNBP でボンド状態を渡す (#322-2)', () => {
      it('AUTH SIGNBP が成功したら bp_bonded (true) を alarm-token に足し、AUTH SIGN にはフォールバックしない', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) return 'AUTH SIGBP pub-bp sig-bp BP=1'
          throw new Error(`unexpected request: ${line}`)
        })
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signAlarmDeviceNonceMock).not.toHaveBeenCalled()
        expect(coreS3Mock.request).toHaveBeenCalledWith('AUTH SIGNBP n1', 'AUTH SIGBP ', 10_000)

        const tokenCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/device/alarm-token'))!
        const body = JSON.parse(tokenCall[1].body)
        expect(body).toEqual({ nonce: 'n1', pubkey: 'pub-bp', sig: 'sig-bp', bp_bonded: true })
      })

      it('AUTH SIGNBP が成功して bp=0 なら bp_bonded: false を送る', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) return 'AUTH SIGBP pub-bp sig-bp BP=0'
          throw new Error(`unexpected request: ${line}`)
        })
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        const tokenCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/device/alarm-token'))!
        const body = JSON.parse(tokenCall[1].body)
        expect(body).toEqual({ nonce: 'n1', pubkey: 'pub-bp', sig: 'sig-bp', bp_bonded: false })
      })

      it('AUTH SIGNBP が未知コマンドとして ERR AUTH で失敗したら AUTH SIGN にフォールバックし、bp_bonded を送らない (古いファーム)', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) throw new Error('ERR AUTH: unknown command')
          throw new Error(`unexpected direct request: ${line}`)
        })
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signAlarmDeviceNonceMock).toHaveBeenCalledWith('n1', coreS3Mock.request)

        const tokenCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/device/alarm-token'))!
        const body = JSON.parse(tokenCall[1].body)
        expect(body).toEqual({ nonce: 'n1', pubkey: 'pub-1', sig: 'sig-1' })
        expect(body).not.toHaveProperty('bp_bonded')
      })

      it('AUTH SIGNBP の応答が壊れていて parse に失敗しても AUTH SIGN にフォールバックする', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) return 'AUTH SIGBP not-enough-parts'
          throw new Error(`unexpected direct request: ${line}`)
        })
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signAlarmDeviceNonceMock).toHaveBeenCalledWith('n1', coreS3Mock.request)
      })

      it('4 語目が小文字の bp=1 (署名対象と同じ綴り) では parse せず AUTH SIGN にフォールバックする (応答は大文字 BP= のみ)', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) return 'AUTH SIGBP pub-bp sig-bp bp=1'
          throw new Error(`unexpected direct request: ${line}`)
        })
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        const fetchMock = routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
          '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const useDeviceToken = await load()
        const { getDeviceJwt } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signAlarmDeviceNonceMock).toHaveBeenCalledWith('n1', coreS3Mock.request)
        const tokenCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/device/alarm-token'))!
        expect(JSON.parse(tokenCall[1].body)).not.toHaveProperty('bp_bonded')
      })

      it('AUTH SIGN へのフォールバックが失敗 (no key 等) したら従来どおり coreS3-sign 段の失敗として扱う', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async (line: string) => {
          if (line.startsWith('AUTH SIGNBP ')) throw new Error('ERR AUTH: unknown command')
          throw new Error(`unexpected direct request: ${line}`)
        })
        signAlarmDeviceNonceMock.mockRejectedValue(new Error('ERR AUTH: no key'))
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, lastFailureStage, lastFailureDetail } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('coreS3-sign')
        expect(lastFailureDetail.value).toBe('no key')
      })
    })

    // 画面 (自動点呼の入口) が「この端末で血圧が必須になるか」を先に知るための公開
    // (Refs ippoan/alc-app#336)。3 状態を潰さない。
    describe('signedBpBonded / refreshSignedBpBonded (#336)', () => {
      const tokenRoutes = {
        '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1', expires_in: 60 }) }),
        '/device/alarm-token': () => ({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) }),
      }

      it('★ 未試行なら null だが hasProbedBpBond は false (「未取得」と「不明」を分ける)', async () => {
        const useDeviceToken = await load()
        const { signedBpBonded, hasProbedBpBond } = useDeviceToken()
        expect(signedBpBonded.value).toBeNull()
        expect(hasProbedBpBond.value).toBe(false)
      })

      it('★ 試し終えたら hasProbedBpBond が true になる (CoreS3 が居なくても)', async () => {
        coreS3Mock.isConnected.value = false
        vi.stubGlobal('fetch', vi.fn())

        const useDeviceToken = await load()
        const { getDeviceJwt, hasProbedBpBond, signedBpBonded } = useDeviceToken()

        expect(hasProbedBpBond.value).toBe(false)
        expect(await getDeviceJwt()).toBeNull()
        // 探索まではした = 判定してよい。結果は「不明」
        expect(hasProbedBpBond.value).toBe(true)
        expect(signedBpBonded.value).toBeNull()
      })

      it('BP=1 → true (ボンドあり)', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=1')
        vi.stubGlobal('fetch', routeFetch(tokenRoutes))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signedBpBonded.value).toBe(true)
        expect(useDeviceToken().hasProbedBpBond.value).toBe(true)
      })

      it('★ BP=0 → false (血圧計が無いと確認できた)。null (不明) と混ぜない', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=0')
        vi.stubGlobal('fetch', routeFetch(tokenRoutes))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signedBpBonded.value).toBe(false)
      })

      it('★ 古いファーム (AUTH SIGN へフォールバック) → null (不明)。JWT は取れている', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => { throw new Error('ERR AUTH: unknown command') })
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        vi.stubGlobal('fetch', routeFetch(tokenRoutes))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signedBpBonded.value).toBeNull()
        // 「古いファームに聞いた結果、分からなかった」= 試し終えている
        expect(useDeviceToken().hasProbedBpBond.value).toBe(true)
      })

      it('CoreS3 が繋がっていない → null (不明)', async () => {
        coreS3Mock.isConnected.value = false
        vi.stubGlobal('fetch', vi.fn())

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded, lastFailureStage } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('no-core-s3')
        expect(signedBpBonded.value).toBeNull()
      })

      it('署名できても token 交換に失敗したら null (サーバにボンド状態が渡っていない)', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=0')
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) }),
          '/device/alarm-token': () => ({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_alarm_token' }) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded, lastFailureStage } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(lastFailureStage.value).toBe('token-exchange')
        expect(signedBpBonded.value).toBeNull()
        expect(useDeviceToken().hasProbedBpBond.value).toBe(true)
      })

      it('★ refreshSignedBpBonded: cache が生きていても署名からやり直して確定させる', async () => {
        // 1 回目は古いファーム扱い (不明) で JWT だけ取れる
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => { throw new Error('ERR AUTH: unknown command') })
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        vi.stubGlobal('fetch', routeFetch(tokenRoutes))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded, refreshSignedBpBonded } = useDeviceToken()

        expect(await getDeviceJwt()).toBe('s3r-jwt')
        expect(signedBpBonded.value).toBeNull()

        // CoreS3 が繋がり直し、今度は SIGNBP に答えた
        coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=0')
        expect(await refreshSignedBpBonded()).toBe(false)
        expect(signedBpBonded.value).toBe(false)
      })

      it('★ refreshSignedBpBonded: 抑止 (backoff) 中でも試し直す — 行き止まりを作らない', async () => {
        coreS3Mock.isConnected.value = true
        coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=0')
        // 1 回目は nonce で失敗させて backoff を立てる
        vi.stubGlobal('fetch', routeFetch({
          '/device/alarm-nonce': () => ({ ok: false, status: 500, json: () => Promise.resolve({}) }),
        }))

        const useDeviceToken = await load()
        const { getDeviceJwt, signedBpBonded, refreshSignedBpBonded, coreS3BackoffUntil } = useDeviceToken()

        expect(await getDeviceJwt()).toBeNull()
        expect(coreS3BackoffUntil.value).toBeGreaterThan(0)
        expect(signedBpBonded.value).toBeNull()

        vi.stubGlobal('fetch', routeFetch(tokenRoutes))
        expect(await refreshSignedBpBonded()).toBe(false)
        expect(signedBpBonded.value).toBe(false)
      })

      it('refreshSignedBpBonded: やり直しても駄目なら null のまま (同じ画面に戻るだけ)', async () => {
        coreS3Mock.isConnected.value = false
        vi.stubGlobal('fetch', vi.fn())

        const useDeviceToken = await load()
        const { refreshSignedBpBonded, signedBpBonded } = useDeviceToken()

        expect(await refreshSignedBpBonded()).toBeNull()
        expect(signedBpBonded.value).toBeNull()
        // CoreS3 の再探索まで含めてやり直している
        expect(coreS3Mock.startupProbe).toHaveBeenCalled()
      })
    })
  })


  describe('hasDeviceJwt (#234-2、兄弟 #p135-c234-3 が使う)', () => {
    it('未取得なら false', async () => {
      const useDeviceToken = await load()
      expect(useDeviceToken().hasDeviceJwt.value).toBe(false)
    })

    it('取得直後、期限内は true', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
      }))

      const useDeviceToken = await load()
      const { getDeviceJwt, hasDeviceJwt } = useDeviceToken()

      expect(hasDeviceJwt.value).toBe(false)
      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(hasDeviceJwt.value).toBe(true)
    })

    it('clearKioskCredential で cache ごと破棄されれば false に戻る', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
      }))

      const useDeviceToken = await load()
      const { getDeviceJwt, hasDeviceJwt, clearKioskCredential } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(hasDeviceJwt.value).toBe(true)

      clearKioskCredential()
      expect(hasDeviceJwt.value).toBe(false)
    })
  })

  describe('CoreS3 の onClose でキャッシュを破棄する (#234-2、親の決定)', () => {
    it('CoreS3 が閉じたら cachedJwt を破棄し、次の getDeviceJwt は再取得する', async () => {
      coreS3Mock.isConnected.value = true
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
      })
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { getDeviceJwt, hasDeviceJwt } = useDeviceToken()

      expect(await getDeviceJwt()).toBe('s3r-jwt')
      expect(hasDeviceJwt.value).toBe(true)
      expect(coreS3Mock.onClose).toHaveBeenCalledTimes(1)

      // CoreS3 の close ハンドラを発火させる (抜線を模す)
      const closeCb = coreS3Mock.onClose.mock.calls[0]![0] as () => void
      closeCb()

      expect(hasDeviceJwt.value).toBe(false)
      expect(await getDeviceJwt()).toBe('s3r-jwt') // 再取得できる
      expect(fetchMock).toHaveBeenCalledTimes(4) // 2 (最初) + 2 (再取得)
    })

    it('useDeviceToken() を複数回呼んでも onClose の登録は 1 回だけ', async () => {
      const useDeviceToken = await load()
      useDeviceToken()
      useDeviceToken()
      useDeviceToken()

      expect(coreS3Mock.onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('startupDeviceJwt / isStartupJwtPending (Refs #238)', () => {
    /** 積まれた microtask (race の finally まで) を流し切る */
    const flush = () => new Promise(resolve => setTimeout(resolve, 0))

    /** 起動時の探索で CoreS3 が繋がる (startupProbe が接続を立てて true) */
    function probeConnects(): void {
      coreS3Mock.startupProbe.mockImplementation(async () => {
        coreS3Mock.isConnected.value = true
        return true
      })
    }

    it('探索で繋がれば JWT が取れるまで true、取れたら false。2 回目は同じ 1 本、途中の getDeviceJwt は合流する', async () => {
      probeConnects()
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      let nonceCalls = 0
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) {
          nonceCalls += 1
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
      }))

      const useDeviceToken = await load()
      const { startupDeviceJwt, getDeviceJwt, isStartupJwtPending, hasDeviceJwt } = useDeviceToken()
      expect(isStartupJwtPending.value).toBe(false)

      const first = startupDeviceJwt()
      expect(isStartupJwtPending.value).toBe(true)
      expect(startupDeviceJwt()).toBe(first)
      // onOpen → attemptClaim の getDeviceJwt() を模す: 起動中の取得に合流する
      const joined = getDeviceJwt()

      await expect(first).resolves.toBe('s3r-jwt')
      await expect(joined).resolves.toBe('s3r-jwt')
      await flush()
      expect(nonceCalls).toBe(1)
      expect(hasDeviceJwt.value).toBe(true)
      expect(isStartupJwtPending.value).toBe(false)
    })

    it('探索で繋がらなければ (CoreS3 無し) null で解決した時点で false、fetch しない', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { startupDeviceJwt, isStartupJwtPending } = useDeviceToken()

      const p = startupDeviceJwt()
      expect(isStartupJwtPending.value).toBe(true)
      await expect(p).resolves.toBeNull()
      await flush()
      expect(isStartupJwtPending.value).toBe(false)
      expect(coreS3Mock.startupProbe).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('起動から 3 秒で取得が終わっていなくても下り、その後に取れれば hasDeviceJwt=true', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        probeConnects()
        signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
        let resolveToken: ((res: unknown) => void) | null = null
        vi.stubGlobal('fetch', vi.fn((url: string) => {
          if (url.endsWith('/device/alarm-nonce')) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
          }
          return new Promise((resolve) => { resolveToken = resolve })
        }))

        const useDeviceToken = await load()
        const { startupDeviceJwt, isStartupJwtPending, hasDeviceJwt } = useDeviceToken()

        const p = startupDeviceJwt()
        await vi.advanceTimersByTimeAsync(2999)
        expect(isStartupJwtPending.value).toBe(true)
        await vi.advanceTimersByTimeAsync(1)
        expect(isStartupJwtPending.value).toBe(false)
        expect(hasDeviceJwt.value).toBe(false)

        expect(resolveToken).not.toBeNull()
        resolveToken!({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
        await expect(p).resolves.toBe('s3r-jwt')
        expect(hasDeviceJwt.value).toBe(true)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('WebSerial 非対応なら null、フラグは立たず、探索も fetch もしない', async () => {
      coreS3Mock.isSupported = false
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const useDeviceToken = await load()
      const { startupDeviceJwt, isStartupJwtPending } = useDeviceToken()

      const p = startupDeviceJwt()
      expect(isStartupJwtPending.value).toBe(false)
      await expect(p).resolves.toBeNull()
      expect(isStartupJwtPending.value).toBe(false)
      expect(coreS3Mock.startupProbe).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('取得に失敗しても (alarm-token 401) 1 本が解決した時点で下り、lastError が残る', async () => {
      probeConnects()
      signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/device/alarm-nonce')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
        }
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_alarm_token' }) })
      }))

      const useDeviceToken = await load()
      const { startupDeviceJwt, isStartupJwtPending, lastError } = useDeviceToken()

      await expect(startupDeviceJwt()).resolves.toBeNull()
      await flush()
      expect(isStartupJwtPending.value).toBe(false)
      expect(lastError.value).toContain('alarm-token http 401')
    })
  })
})

// ============================================================
// auth-worker への HTTP の上限 (Refs ippoan/alc-app#338)。
// ここがハングすると single-flight (`jwtInFlight`) が永久 pending になり、
// 以後すべての API 呼び出しが同じ promise を待って連鎖的に固まる。
// AUTH SIGNBP / AUTH SIGN は既に 10 秒で切り上げているのに、その前後の
// HTTP には上限が無い、という非対称を解消する。
// ============================================================
describe('auth-worker への HTTP の上限 (Refs ippoan/alc-app#338)', () => {
  it('alarm-nonce / alarm-token に 10 秒の signal が載る', async () => {
    coreS3Mock.isConnected.value = true
    signAlarmDeviceNonceMock.mockResolvedValue({ pubkey: 'pub-1', sig: 'sig-1' })
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/device/alarm-nonce')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    expect(await useDeviceToken().getDeviceJwt()).toBe('s3r-jwt')

    expect(fetchMock.mock.calls).toHaveLength(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
    expect(spy).toHaveBeenCalledWith(10_000)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('credential 経路 (/device/token) にも signal が載る', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'jwt-1', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)

    expect(await getDeviceJwt()).toBe('jwt-1')
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  // #336 の refreshSignedBpBonded() は getDeviceJwt() を通さず tryCoreS3Jwt を
  // 直に呼ぶ (cache を返して終わりにしないため)。timeout は tryCoreS3Jwt の中の
  // fetch に入れてあるので、この入口からも効く — それを固定する。
  it('refreshSignedBpBonded (#336 の直呼び経路) の fetch にも signal が載る', async () => {
    coreS3Mock.isConnected.value = true
    coreS3Mock.request.mockImplementation(async () => 'AUTH SIGBP pub-bp sig-bp BP=1')
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/device/alarm-nonce')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ nonce: 'n1' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 's3r-jwt', expires_in: 900 }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    expect(await useDeviceToken().refreshSignedBpBonded()).toBe(true)

    expect(fetchMock.mock.calls).toHaveLength(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('pairKioskDevice (/device/pair) にも signal が載る', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ device_id: 'd1', device_secret: 's1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    await useDeviceToken().pairKioskDevice('admin-jwt', 'kiosk-1')

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('timeout したら null を返し、single-flight (jwtInFlight) を解いて次の試行を通す', async () => {
    const timeoutError = new Error('signal timed out')
    timeoutError.name = 'TimeoutError'
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'jwt-2', expires_in: 3600 }) })
    vi.stubGlobal('fetch', fetchMock)

    const useDeviceToken = await load()
    const { storeKioskCredential, getDeviceJwt } = useDeviceToken()
    storeKioskCredential(ID, SECRET)

    // 1 回目は timeout。**自動再送はしない** (サーバ側が成功していることがあるため)
    expect(await getDeviceJwt()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // jwtInFlight が null に戻っているので、次の呼び出しは道連れにならない
    expect(await getDeviceJwt()).toBe('jwt-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
