import { describe, it, expect, vi, beforeEach } from 'vitest'

// useDeviceToken はモジュールスコープに credential ref + JWT cache を持つ
// シングルトンなので、テスト毎に resetModules + dynamic import で分離する。
type Mod = typeof import('~/composables/useDeviceToken')

async function load(): Promise<Mod['useDeviceToken']> {
  const mod = await import('~/composables/useDeviceToken')
  return mod.useDeviceToken
}

const ID = 'dev-abc'
const SECRET = 'sec-xyz'

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.resetModules()
  localStorage.clear()
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
})
