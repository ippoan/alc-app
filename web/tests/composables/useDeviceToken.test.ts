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
vi.mock('~/composables/useDeviceLogin', () => ({
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
})

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
