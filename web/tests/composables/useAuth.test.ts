import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const mockFetch = vi.fn()

/** テスト用の偽 JWT を生成 (署名なし) */
function createFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  // Use standard base64 (btoa) for ASCII payloads
  const body = btoa(JSON.stringify(payload))
  const sig = 'fake-signature'
  return `${header}.${body}.${sig}`
}

/** マルチバイト文字を含む JWT を生成 (Base64url エンコード) */
function createFakeJwtMultibyte(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const jsonStr = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(jsonStr)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  const body = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const sig = 'fake-signature'
  return `${header}.${body}.${sig}`
}

/** exp 付き JWT を生成 */
function createFakeJwtWithExp(payload: Record<string, unknown>, expiresInSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec
  return createFakeJwt({ ...payload, exp })
}

const defaultPayload = {
  sub: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenant_id: 'tenant-1',
  role: 'admin',
}

const envMock = vi.hoisted(() => ({
  isClient: true,
}))
vi.mock('~/utils/env', () => envMock)

describe('useAuth', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch)
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()
    mockFetch.mockReset()
    // Reset singleton state: re-import fresh module.
    // useAuth uses module-level state; we clean up the previous instance's window
    // listeners via logout(), then reset the module cache so refs are fresh.
    const { useAuth } = await import('~/composables/useAuth')
    const auth = useAuth()
    if (auth.accessToken.value) {
      // logout() redirects via window.location; mock it so cleanup doesn't navigate.
      const origLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { ...origLocation, origin: 'https://example.com', href: '', set href(_v: string) {} },
        writable: true,
        configurable: true,
      })
      auth.logout()
      Object.defineProperty(window, 'location', { value: origLocation, writable: true, configurable: true })
    }
    auth.deactivateDevice()
    mockFetch.mockReset()

    // Reset `initialized` by resetting the module cache
    vi.resetModules()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('device activation', () => {
    it('should activate device and store tenant_id in localStorage', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, deviceTenantId, isDeviceActivated } = useAuth()

      activateDevice('tenant-123')

      expect(deviceTenantId.value).toBe('tenant-123')
      expect(isDeviceActivated.value).toBe(true)
      expect(localStorage.getItem('alc_device_tenant_id')).toBe('tenant-123')
    })

    it('should activate device with device_id and store both', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, deviceTenantId, deviceId } = useAuth()

      activateDevice('tenant-123', 'dev-456')

      expect(deviceTenantId.value).toBe('tenant-123')
      expect(deviceId.value).toBe('dev-456')
      expect(localStorage.getItem('alc_device_tenant_id')).toBe('tenant-123')
      expect(localStorage.getItem('alc_device_id')).toBe('dev-456')
    })

    it('should call Android.setDeviceId when Android bridge exists', async () => {
      const mockSetDeviceId = vi.fn()
      ;(window as any).Android = { setDeviceId: mockSetDeviceId }

      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice } = useAuth()

      activateDevice('tenant-123', 'dev-789')

      expect(mockSetDeviceId).toHaveBeenCalledWith('dev-789')
      delete (window as any).Android
    })

    it('should deactivate device and clear localStorage', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, deactivateDevice, deviceTenantId, deviceId, isDeviceActivated } = useAuth()

      activateDevice('tenant-123', 'dev-456')
      deactivateDevice()

      expect(deviceTenantId.value).toBeNull()
      expect(deviceId.value).toBeNull()
      expect(isDeviceActivated.value).toBe(false)
      expect(localStorage.getItem('alc_device_tenant_id')).toBeNull()
      expect(localStorage.getItem('alc_device_id')).toBeNull()
    })

    it('should store settings_token on activate and clear on deactivate (Refs rust-alc-api#388)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, deactivateDevice, deviceSettingsToken } = useAuth()

      activateDevice('tenant-123', 'dev-456', 'token-abc')

      expect(deviceSettingsToken.value).toBe('token-abc')
      expect(localStorage.getItem('alc_device_settings_token')).toBe('token-abc')

      deactivateDevice()

      expect(deviceSettingsToken.value).toBeNull()
      expect(localStorage.getItem('alc_device_settings_token')).toBeNull()
    })

    it('should call Android.setDeviceId("") on deactivate', async () => {
      const mockSetDeviceId = vi.fn()
      ;(window as any).Android = { setDeviceId: mockSetDeviceId }

      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, deactivateDevice } = useAuth()

      activateDevice('tenant-1', 'dev-1')
      mockSetDeviceId.mockClear()
      deactivateDevice()

      expect(mockSetDeviceId).toHaveBeenCalledWith('')
      delete (window as any).Android
    })

    it('activateFromRegistration should activate device and store kiosk credential when present (Refs rust-alc-api#480)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateFromRegistration, deviceTenantId, deviceId } = useAuth()

      activateFromRegistration({
        tenant_id: 'tenant-reg',
        device_id: 'dev-reg',
        settings_token: 'token-reg',
        auth_device_id: 'auth-dev-reg',
        device_secret: 'secret-reg',
      })

      expect(deviceTenantId.value).toBe('tenant-reg')
      expect(deviceId.value).toBe('dev-reg')
      const { useDeviceToken } = await import('~/composables/useDeviceToken')
      const { kioskDeviceId } = useDeviceToken()
      expect(kioskDeviceId.value).toBe('auth-dev-reg')
    })

    it('activateFromRegistration should activate device without credential when absent', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateFromRegistration, deviceTenantId } = useAuth()

      activateFromRegistration({ tenant_id: 'tenant-nocred' })

      expect(deviceTenantId.value).toBe('tenant-nocred')
    })

    it('activateFromRegistration should be a no-op when tenant_id is missing', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateFromRegistration, deviceTenantId } = useAuth()

      activateFromRegistration({})

      expect(deviceTenantId.value).toBeNull()
    })

    it('should call Android.setSettingsToken after setDeviceId in order (Refs rust-alc-api#480)', async () => {
      const order: string[] = []
      ;(window as any).Android = {
        setDeviceId: vi.fn(() => order.push('setDeviceId')),
        setSettingsToken: vi.fn(() => order.push('setSettingsToken')),
      }

      const { useAuth } = await import('~/composables/useAuth')
      useAuth().activateDevice('tenant-1', 'dev-1', 'stok')

      expect((window as any).Android.setSettingsToken).toHaveBeenCalledWith('stok')
      // 順序が重要: setDeviceId が native の settings_token を remove するので後に再設定
      expect(order).toEqual(['setDeviceId', 'setSettingsToken'])
      delete (window as any).Android
    })

    it('should call Android.setSettingsToken("") when no settings token given', async () => {
      const mockSetSettingsToken = vi.fn()
      ;(window as any).Android = { setDeviceId: vi.fn(), setSettingsToken: mockSetSettingsToken }

      const { useAuth } = await import('~/composables/useAuth')
      useAuth().activateDevice('tenant-1', 'dev-1')

      expect(mockSetSettingsToken).toHaveBeenCalledWith('')
      delete (window as any).Android
    })

    it('activateFromRegistration should pass credential to Android.setDeviceCredential last (Refs rust-alc-api#480)', async () => {
      const order: string[] = []
      ;(window as any).Android = {
        setDeviceId: vi.fn(() => order.push('setDeviceId')),
        setSettingsToken: vi.fn(() => order.push('setSettingsToken')),
        setDeviceCredential: vi.fn(() => order.push('setDeviceCredential')),
      }

      const { useAuth } = await import('~/composables/useAuth')
      useAuth().activateFromRegistration({
        tenant_id: 'tenant-reg',
        device_id: 'dev-reg',
        settings_token: 'token-reg',
        auth_device_id: 'auth-dev-reg',
        device_secret: 'secret-reg',
      })

      expect((window as any).Android.setDeviceCredential).toHaveBeenCalledWith('auth-dev-reg', 'secret-reg')
      // credential は setDeviceId → setSettingsToken の後 (最後) に渡す
      expect(order).toEqual(['setDeviceId', 'setSettingsToken', 'setDeviceCredential'])
      delete (window as any).Android
    })

    it('deactivateDevice calls Android.resetDeviceRegistration and clears kiosk credential (Refs rust-alc-api#480)', async () => {
      const mockReset = vi.fn()
      ;(window as any).Android = { setDeviceId: vi.fn(), resetDeviceRegistration: mockReset }

      const { useAuth } = await import('~/composables/useAuth')
      const { activateFromRegistration, deactivateDevice } = useAuth()

      activateFromRegistration({
        tenant_id: 'tenant-reg',
        device_id: 'dev-reg',
        auth_device_id: 'auth-dev-reg',
        device_secret: 'secret-reg',
      })
      deactivateDevice()

      expect(mockReset).toHaveBeenCalled()
      const { useDeviceToken } = await import('~/composables/useDeviceToken')
      expect(useDeviceToken().kioskDeviceId.value).toBeNull()
      delete (window as any).Android
    })
  })

  describe('reAuthenticateDevice (再認証、Refs rust-alc-api#495)', () => {
    it('returns false when device is not registered (no deviceId)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { reAuthenticateDevice } = useAuth()

      expect(await reAuthenticateDevice()).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('stores credential and returns true on success', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ auth_device_id: 'auth-dev-1', device_secret: 'secret-1' }),
      })

      const ok = await auth.reAuthenticateDevice()

      expect(ok).toBe(true)
      expect(mockFetch.mock.calls[0][0]).toBe('/api/devices/re-pair')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.device_id).toBe('dev-1')
      const { useDeviceToken } = await import('~/composables/useDeviceToken')
      expect(useDeviceToken().kioskDeviceId.value).toBe('auth-dev-1')
    })

    it('returns false on non-2xx without surfacing the reason (window 外 / cooldown / TOFU 不一致等)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' })

      expect(await auth.reAuthenticateDevice()).toBe(false)
    })

    it('returns false when response is missing credential fields', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

      expect(await auth.reAuthenticateDevice()).toBe(false)
    })

    it('prefers Android.getHardwareId() and calls setDeviceCredential on success', async () => {
      const setDeviceCredential = vi.fn()
      ;(window as any).Android = { getHardwareId: vi.fn(() => 'hw-android'), setDeviceCredential }

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ auth_device_id: 'auth-dev-2', device_secret: 'secret-2' }),
      })

      await auth.reAuthenticateDevice()

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.hardware_id).toBe('hw-android')
      expect(setDeviceCredential).toHaveBeenCalledWith('auth-dev-2', 'secret-2')
      delete (window as any).Android
    })

    it('falls back to web install id when Android bridge is absent', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ auth_device_id: 'auth-dev-3', device_secret: 'secret-3' }),
      })

      await auth.reAuthenticateDevice()

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(typeof body.hardware_id).toBe('string')
      expect(body.hardware_id.length).toBeGreaterThan(0)
    })

    it('includes settings_token in the request body when present', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1', 'stok-1')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ auth_device_id: 'auth-dev-4', device_secret: 'secret-4' }),
      })

      await auth.reAuthenticateDevice()

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.settings_token).toBe('stok-1')
    })

    it('falls back to web install id when Android bridge lacks getHardwareId (old APK)', async () => {
      ;(window as any).Android = { setDeviceCredential: vi.fn() }

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ auth_device_id: 'auth-dev-5', device_secret: 'secret-5' }),
      })

      await auth.reAuthenticateDevice()

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(typeof body.hardware_id).toBe('string')
      expect(body.hardware_id.length).toBeGreaterThan(0)
      delete (window as any).Android
    })

    it('returns false when fetch throws (network error)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.activateDevice('tenant-1', 'dev-1')
      mockFetch.mockRejectedValueOnce(new Error('network down'))

      expect(await auth.reAuthenticateDevice()).toBe(false)
    })
  })

  describe('session refresh (cookie)', () => {
    function setDocCookie(value: string) {
      Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true })
    }
    afterEach(() => setDocCookie(''))

    // #434: cookie session モデルでは rust の /api/auth/refresh は叩かず、auth-worker が
    // 配布した logi_auth_token cookie を読み直して session を再確立する。
    it('re-establishes session from logi_auth_token cookie', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)

      const { useAuth } = await import('~/composables/useAuth')
      const { refreshAccessToken, accessToken, user } = useAuth()
      await refreshAccessToken()

      expect(accessToken.value).toBe(fakeJwt)
      expect(user.value?.email).toBe('test@example.com')
    })

    it('rejects when no session cookie is present', async () => {
      setDocCookie('other=1')
      const { useAuth } = await import('~/composables/useAuth')
      const { refreshAccessToken } = useAuth()
      await expect(refreshAccessToken()).rejects.toThrow('セッションがありません')
    })

    it('decodes multibyte claims from the cookie JWT', async () => {
      const fakeJwt = createFakeJwtMultibyte({ ...defaultPayload, name: '田中太郎' })
      setDocCookie(`logi_auth_token=${fakeJwt}`)

      const { useAuth } = await import('~/composables/useAuth')
      const { refreshAccessToken, user } = useAuth()
      await refreshAccessToken()

      expect(user.value?.name).toBe('田中太郎')
    })
  })

  describe('init', () => {
    function setDocCookie(value: string) {
      Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true })
    }
    afterEach(() => setDocCookie(''))

    it('should restore session from logi_auth_token cookie', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)

      const { useAuth } = await import('~/composables/useAuth')
      const { init, isAuthenticated, isLoading } = useAuth()

      await init()

      expect(isAuthenticated.value).toBe(true)
      expect(isLoading.value).toBe(false)
    })

    it('stays unauthenticated when no cookie is present', async () => {
      setDocCookie('')
      const { useAuth } = await import('~/composables/useAuth')
      const { init, isAuthenticated, isLoading } = useAuth()

      await init()

      expect(isAuthenticated.value).toBe(false)
      expect(isLoading.value).toBe(false)
    })

    it('should not run twice (idempotent)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { init, isLoading } = useAuth()

      await init()
      expect(isLoading.value).toBe(false)

      // Second call should be a no-op
      mockFetch.mockRejectedValueOnce(new Error('should not be called'))
      await init()
      // No additional fetch calls
    })

    it('should auto-activate from Android provisioning info', async () => {
      ;(window as any).Android = {
        getProvisioningInfo: () => JSON.stringify({
          is_device_owner: true,
          device_id: 'prov-dev-1',
          tenant_id: 'prov-tenant-1',
        }),
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceTenantId, deviceId } = useAuth()

      await init()

      expect(deviceTenantId.value).toBe('prov-tenant-1')
      expect(deviceId.value).toBe('prov-dev-1')
      delete (window as any).Android
    })

    it('should auto-activate with empty tenant_id fallback', async () => {
      ;(window as any).Android = {
        getProvisioningInfo: () => JSON.stringify({
          is_device_owner: true,
          device_id: 'prov-dev-2',
          // no tenant_id → || '' fallback
        }),
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceTenantId, deviceId } = useAuth()

      await init()

      expect(deviceTenantId.value).toBe('')
      expect(deviceId.value).toBe('prov-dev-2')
      delete (window as any).Android
    })

    it('should handle Android provisioning info parse error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      ;(window as any).Android = {
        getProvisioningInfo: () => 'invalid-json',
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceTenantId } = useAuth()

      await init()

      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to read provisioning info:',
        expect.any(Error),
      )
      expect(deviceTenantId.value).toBeNull()

      delete (window as any).Android
      warnSpy.mockRestore()
    })

    it('should skip provisioning if already device-activated', async () => {
      localStorage.setItem('alc_device_tenant_id', 'existing-tenant')

      ;(window as any).Android = {
        getProvisioningInfo: vi.fn(),
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceTenantId } = useAuth()

      await init()

      // getProvisioningInfo should not be called
      expect((window as any).Android.getProvisioningInfo).not.toHaveBeenCalled()
      expect(deviceTenantId.value).toBe('existing-tenant')
      delete (window as any).Android
    })

    it('should set __deviceOwnerActivated callback', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceTenantId, deviceId } = useAuth()

      await init()

      // The callback should be set
      expect((window as any).__deviceOwnerActivated).toBeDefined()

      // Call it
      ;(window as any).__deviceOwnerActivated('cb-tenant', 'cb-dev')
      expect(deviceTenantId.value).toBe('cb-tenant')
      expect(deviceId.value).toBe('cb-dev')

      delete (window as any).__deviceOwnerActivated
    })

    it('should skip provisioning when device_id is empty', async () => {
      ;(window as any).Android = {
        getProvisioningInfo: () => JSON.stringify({
          is_device_owner: true,
          device_id: '',
        }),
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceId } = useAuth()

      await init()

      expect(deviceId.value).toBeNull()
      delete (window as any).Android
    })

    it('should skip provisioning when is_device_owner is false', async () => {
      ;(window as any).Android = {
        getProvisioningInfo: () => JSON.stringify({
          is_device_owner: false,
          device_id: 'dev-1',
        }),
      }

      const { useAuth } = await import('~/composables/useAuth')
      const { init, deviceId } = useAuth()

      await init()

      // device should not be activated
      expect(deviceId.value).toBeNull()
      delete (window as any).Android
    })
  })

  describe('logout', () => {
    let restoreLocation: (() => void) | null = null
    let hrefSetter = vi.fn()
    function setDocCookie(value: string) {
      Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true })
    }
    function mockLocation() {
      hrefSetter = vi.fn()
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: {
          ...originalLocation,
          origin: 'https://example.com',
          href: '',
          set href(val: string) { hrefSetter(val) },
        },
        writable: true,
        configurable: true,
      })
      restoreLocation = () => Object.defineProperty(window, 'location', {
        value: originalLocation, writable: true, configurable: true,
      })
    }
    afterEach(() => {
      setDocCookie('')
      restoreLocation?.()
      restoreLocation = null
    })

    it('clears token, keeps device tenant, and redirects to auth-worker /logout', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { activateDevice, logout, consumeAuthCookie, accessToken, deviceTenantId, isAuthenticated } = useAuth()

      activateDevice('tenant-abc')
      localStorage.setItem('alc_refresh_token', 'rt_x')
      // cookie の tenant は空 = consumeAuthCookie が activateDevice しない (端末 tenant 保持の検証)
      const fakeJwt = createFakeJwtWithExp({ ...defaultPayload, tenant_id: '' }, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      consumeAuthCookie()

      mockLocation()
      logout()

      expect(accessToken.value).toBeNull()
      expect(isAuthenticated.value).toBe(false)
      // 端末の tenant は保持 (キオスク継続)
      expect(deviceTenantId.value).toBe('tenant-abc')
      expect(localStorage.getItem('alc_device_tenant_id')).toBe('tenant-abc')
      // refresh token は除去
      expect(localStorage.getItem('alc_refresh_token')).toBeNull()
      // auth-worker /logout?redirect_uri=.../login へ遷移 (cookie クリアを委譲)
      const url = hrefSetter.mock.calls[0]?.[0] as string
      expect(url).toContain('/logout')
      expect(url).toContain(`redirect_uri=${encodeURIComponent('https://example.com/login')}`)
    })

    it('redirects even when not authenticated (no inactivity timer to clear)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { logout, accessToken } = useAuth()

      // 未ログイン = inactivityTimerId 未設定。stopInactivityWatch の clear 分岐 (false) を通る
      mockLocation()
      logout()

      expect(accessToken.value).toBeNull()
      const url = hrefSetter.mock.calls[0]?.[0] as string
      expect(url).toContain('/logout')
    })
  })

  describe('inactivity auto-logout', () => {
    let restoreLocation: (() => void) | null = null
    function setDocCookie(value: string) {
      Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true })
    }
    function mockLocation() {
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, origin: 'https://example.com', href: '', set href(_v: string) {} },
        writable: true,
        configurable: true,
      })
      restoreLocation = () => Object.defineProperty(window, 'location', {
        value: originalLocation, writable: true, configurable: true,
      })
    }
    afterEach(() => {
      setDocCookie('')
      restoreLocation?.()
      restoreLocation = null
    })

    it('should auto-logout after 5 minutes of inactivity', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.consumeAuthCookie()

      expect(auth.isAuthenticated.value).toBe(true)

      mockLocation()
      // Advance timer by 5 minutes → inactivity logout fires
      vi.advanceTimersByTime(5 * 60 * 1000)

      await vi.waitFor(() => {
        expect(auth.isAuthenticated.value).toBe(false)
      })
    })

    it('should reset inactivity timer on user activity', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      auth.consumeAuthCookie()

      // After 4 minutes, simulate user activity
      vi.advanceTimersByTime(4 * 60 * 1000)
      window.dispatchEvent(new Event('mousedown'))

      // After another 4 minutes (total 8 min from start), should still be logged in
      vi.advanceTimersByTime(4 * 60 * 1000)
      expect(auth.isAuthenticated.value).toBe(true)

      // But 5 min after last activity, should be logged out
      mockLocation()
      vi.advanceTimersByTime(1 * 60 * 1000)

      await vi.waitFor(() => {
        expect(auth.isAuthenticated.value).toBe(false)
      })
    })

    it('should not set inactivity timer when not authenticated', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      // Not authenticated - resetInactivityTimer should be a no-op
      // Advance time - no logout should happen
      vi.advanceTimersByTime(10 * 60 * 1000)
      // No error, nothing happens
    })
  })

  describe('loginWithGoogleRedirect', () => {
    it('redirects to auth-worker /oauth/google/redirect with callback redirect_uri', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { loginWithGoogleRedirect } = useAuth()

      const hrefSetter = vi.fn()
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: {
          ...originalLocation,
          origin: 'https://example.com',
          href: '',
          set href(val: string) { hrefSetter(val) },
        },
        writable: true,
        configurable: true,
      })

      loginWithGoogleRedirect('/dashboard')

      expect(sessionStorage.getItem('oauth_redirect')).toBe('/dashboard')
      const url = hrefSetter.mock.calls[0]?.[0] as string
      expect(url).toContain('/oauth/google/redirect')
      expect(url).toContain(`redirect_uri=${encodeURIComponent('https://example.com/auth/callback')}`)

      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
    })

    it('should not store redirect when not provided', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { loginWithGoogleRedirect } = useAuth()

      const hrefSetter = vi.fn()
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, origin: 'https://example.com', href: '', set href(val: string) { hrefSetter(val) } },
        writable: true,
        configurable: true,
      })

      loginWithGoogleRedirect()

      expect(sessionStorage.getItem('oauth_redirect')).toBeNull()
      expect(hrefSetter).toHaveBeenCalled()

      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
    })

    it('is a no-op on the server (isClient=false)', async () => {
      envMock.isClient = false
      const { useAuth } = await import('~/composables/useAuth')
      const { loginWithGoogleRedirect } = useAuth()

      const hrefSetter = vi.fn()
      const originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, origin: 'https://example.com', href: '', set href(val: string) { hrefSetter(val) } },
        writable: true,
        configurable: true,
      })

      loginWithGoogleRedirect('/x')

      expect(hrefSetter).not.toHaveBeenCalled()

      Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
      envMock.isClient = true
    })
  })

  describe('consumeAuthCookie', () => {
    function setDocCookie(value: string) {
      Object.defineProperty(document, 'cookie', { value, writable: true, configurable: true })
    }
    afterEach(() => setDocCookie(''))

    it('returns false when no logi_auth_token cookie present', async () => {
      setDocCookie('other=1')
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(false)
      expect(auth.isAuthenticated.value).toBe(false)
    })

    it('returns false on the server (isClient=false)', async () => {
      envMock.isClient = false
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(false)
      envMock.isClient = true
    })

    it('establishes session and activates device from cookie JWT', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(true)
      expect(auth.isAuthenticated.value).toBe(true)
      expect(auth.user.value?.email).toBe('test@example.com')
      expect(auth.deviceTenantId.value).toBe('tenant-1')
    })

    it('does not activate device when tenant_id is empty', async () => {
      const fakeJwt = createFakeJwtWithExp({ ...defaultPayload, tenant_id: '', org: '' }, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(true)
      expect(auth.deviceTenantId.value).toBeNull()
    })

    it('keeps login state even when JWT payload is malformed', async () => {
      setDocCookie('logi_auth_token=not-a-jwt')
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(true)
      expect(auth.accessToken.value).toBe('not-a-jwt')
    })

    it('uses fallback claim fields (user_id / org) and defaults for missing email/name/role', async () => {
      const fakeJwt = createFakeJwtWithExp({ user_id: 'uid-9', org: 'org-9' }, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(true)
      expect(auth.user.value).toEqual({ id: 'uid-9', email: '', name: '', tenant_id: 'org-9', role: 'viewer' })
      expect(auth.deviceTenantId.value).toBe('org-9')
    })

    it('defaults id to empty string when neither sub nor user_id present', async () => {
      const fakeJwt = createFakeJwtWithExp({ org: 'org-2' }, 3600)
      setDocCookie(`logi_auth_token=${fakeJwt}`)
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      expect(auth.consumeAuthCookie()).toBe(true)
      expect(auth.user.value?.id).toBe('')
      expect(auth.user.value?.tenant_id).toBe('org-2')
    })
  })

  describe('handleLineworksHash', () => {
    it('should return false when no hash token', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      expect(auth.handleLineworksHash()).toBe(false)
    })

    it('should return false when hash has token but no lw_callback', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: '#token=abc',
          search: '',
          pathname: '/test',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      expect(auth.handleLineworksHash()).toBe(false)
    })

    it('should process hash with lw_callback in hash', async () => {
      const fakeJwt = createFakeJwt({
        sub: 'lw-user',
        email: 'lw@example.com',
        name: 'LW User',
        tenant_id: 'lw-tenant',
        role: 'viewer',
      })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}&refresh_token=rt_lw&lw_callback=1`,
          search: '',
          pathname: '/callback',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      expect(auth.accessToken.value).toBe(fakeJwt)
      expect(auth.user.value?.email).toBe('lw@example.com')
      expect(auth.deviceTenantId.value).toBe('lw-tenant')
      expect(localStorage.getItem('alc_refresh_token')).toBe('rt_lw')
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/callback')

      replaceStateSpy.mockRestore()
    })

    it('should process hash with lw_callback in query string', async () => {
      const fakeJwt = createFakeJwt({
        sub: 'lw-user',
        email: 'lw@example.com',
        name: 'LW User',
        org: 'org-tenant',
        role: 'viewer',
      })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}`,
          search: '?lw_callback=1&other=1',
          pathname: '/page',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      expect(auth.user.value?.tenant_id).toBe('org-tenant')
      // lw_callback should be removed from query, other kept
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/page?other=1')

      replaceStateSpy.mockRestore()
    })

    it('should handle hash token with no refresh_token', async () => {
      const fakeJwt = createFakeJwt({ sub: 'user', email: '', name: '', role: 'viewer' })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}&lw_callback=1`,
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      // refresh_token not set since not in hash
      expect(localStorage.getItem('alc_refresh_token')).toBeNull()

      replaceStateSpy.mockRestore()
    })

    it('should handle JWT decode failure in hash token', async () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: '#token=bad.!!!.jwt&lw_callback=1',
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      // Token is set even with decode failure
      expect(auth.accessToken.value).toBe('bad.!!!.jwt')
      // user may be null or partially set

      replaceStateSpy.mockRestore()
    })

    it('should return false when hash has token= but value is empty', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          hash: '#token=&lw_callback=1',
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      // token is empty string, which is falsy
      expect(auth.handleLineworksHash()).toBe(false)
    })
  })

  describe('handleLineworksHash JWT fallback fields', () => {
    it('should handle token with no payload part (no dots)', async () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: '#token=headerwithoutdots&lw_callback=1',
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      // Token is set even with no payload
      expect(auth.accessToken.value).toBe('headerwithoutdots')
      // user remains null because decode throws
      expect(auth.user.value).toBeNull()

      replaceStateSpy.mockRestore()
    })

    it('should use user_id when sub is missing', async () => {
      const fakeJwt = createFakeJwt({
        user_id: 'fallback-user-id',
        email: 'fb@example.com',
        name: 'Fallback User',
        tenant_id: 'tenant-fb',
        role: 'admin',
      })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}&lw_callback=1`,
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      expect(auth.user.value?.id).toBe('fallback-user-id')

      replaceStateSpy.mockRestore()
    })

    it('should default id to empty string when both sub and user_id are missing', async () => {
      const fakeJwt = createFakeJwt({
        email: 'noid@example.com',
        name: 'No ID',
        tenant_id: 'tenant-noid',
        role: 'admin',
      })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}&lw_callback=1`,
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      expect(auth.user.value?.id).toBe('')

      replaceStateSpy.mockRestore()
    })

    it('should default role to viewer when role is missing', async () => {
      const fakeJwt = createFakeJwt({
        sub: 'user-no-role',
        email: 'nr@example.com',
        name: 'No Role',
        tenant_id: 'tenant-nr',
      })
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          hash: `#token=${fakeJwt}&lw_callback=1`,
          search: '',
          pathname: '/p',
        },
        writable: true,
        configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      const result = auth.handleLineworksHash()

      expect(result).toBe(true)
      expect(auth.user.value?.role).toBe('viewer')

      replaceStateSpy.mockRestore()
    })
  })

  describe('isAuthenticated computed', () => {
    it('should be false when no access token', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const { isAuthenticated } = useAuth()
      expect(isAuthenticated.value).toBe(false)
    })

    it('should be true after session refresh from cookie', async () => {
      const fakeJwt = createFakeJwtWithExp(defaultPayload, 3600)
      Object.defineProperty(document, 'cookie', {
        value: `logi_auth_token=${fakeJwt}`, writable: true, configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      await auth.refreshAccessToken()

      expect(auth.isAuthenticated.value).toBe(true)
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true })
    })
  })

  describe('SSR branches (isClient=false)', () => {
    beforeEach(() => {
      envMock.isClient = false
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockReset()
    })

    afterEach(() => {
      envMock.isClient = true
    })

    it('deviceTenantId and deviceId are null on server', async () => {
      localStorage.setItem('alc_device_tenant_id', 'should-not-read')
      localStorage.setItem('alc_device_id', 'should-not-read')

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      expect(auth.deviceTenantId.value).toBeNull()
      expect(auth.deviceId.value).toBeNull()
    })

    it('activateDevice does not touch localStorage when isClient=false', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      auth.activateDevice('tenant-ssr', 'dev-ssr')

      // refs are updated (in-memory)
      expect(auth.deviceTenantId.value).toBe('tenant-ssr')
      expect(auth.deviceId.value).toBe('dev-ssr')
      // but localStorage is not touched
      expect(localStorage.getItem('alc_device_tenant_id')).toBeNull()
      expect(localStorage.getItem('alc_device_id')).toBeNull()
    })

    it('deactivateDevice does not touch localStorage when isClient=false', async () => {
      localStorage.setItem('alc_device_tenant_id', 'pre-existing')
      localStorage.setItem('alc_device_id', 'pre-existing')

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      auth.deactivateDevice()

      // refs are cleared
      expect(auth.deviceTenantId.value).toBeNull()
      expect(auth.deviceId.value).toBeNull()
      // localStorage is NOT touched (guard skips the block)
      expect(localStorage.getItem('alc_device_tenant_id')).toBe('pre-existing')
      expect(localStorage.getItem('alc_device_id')).toBe('pre-existing')
    })

    it('logout does not remove localStorage or redirect when isClient=false', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      // Set up a refresh token in localStorage (simulating pre-existing state)
      localStorage.setItem('alc_refresh_token', 'rt-ssr-test')

      // No window.location navigation on the server (isClient guard skips the block).
      auth.logout()

      // accessToken は guard 外で常にクリアされる
      expect(auth.accessToken.value).toBeNull()
      // localStorage は触られない (isClient guard で skip)
      expect(localStorage.getItem('alc_refresh_token')).toBe('rt-ssr-test')
    })

    it('handleLineworksHash returns false when isClient=false', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      expect(auth.handleLineworksHash()).toBe(false)
    })

    it('init() skips cookie/localStorage and Android bridge when isClient=false', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      await auth.init()

      // isLoading is set to false
      expect(auth.isLoading.value).toBe(false)
      // consumeAuthCookie returns false on the server → not authenticated
      expect(auth.isAuthenticated.value).toBe(false)
    })

    it('refreshAccessToken() rejects on the server (no cookie access)', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      // consumeAuthCookie returns false (isClient=false) → reject
      await expect(auth.refreshAccessToken()).rejects.toThrow('セッションがありません')
    })
  })

  describe('staging auth bypass', () => {
    it('should auto-activate device when stagingTenantId is set', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      expect(auth.isDeviceActivated.value).toBe(false)
      auth.applyStagingBypass('staging-tenant-123')

      expect(auth.isDeviceActivated.value).toBe(true)
      expect(auth.deviceTenantId.value).toBe('staging-tenant-123')
    })

    it('should not auto-activate when stagingTenantId is empty', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      auth.applyStagingBypass('')
      expect(auth.isDeviceActivated.value).toBe(false)
    })

    it('should not auto-activate when already authenticated', async () => {
      const jwt = createFakeJwtWithExp({ ...defaultPayload, tenant_id: '' }, 3600)
      Object.defineProperty(document, 'cookie', {
        value: `logi_auth_token=${jwt}`, writable: true, configurable: true,
      })

      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()
      await auth.init()

      expect(auth.isAuthenticated.value).toBe(true)
      auth.applyStagingBypass('staging-tenant-123')
      expect(auth.isDeviceActivated.value).toBe(false)
      Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true })
    })

    it('should not auto-activate when already device-activated', async () => {
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      auth.activateDevice('existing-tenant')
      expect(auth.isDeviceActivated.value).toBe(true)

      auth.applyStagingBypass('different-tenant')
      // 既にアクティベート済みなので変更されない
      expect(auth.deviceTenantId.value).toBe('existing-tenant')
    })

    it('should skip bypass once when alc_skip_staging_bypass flag is set (post-reset)', async () => {
      sessionStorage.setItem('alc_skip_staging_bypass', '1')
      const { useAuth } = await import('~/composables/useAuth')
      const auth = useAuth()

      // フラグが立っている間はバイパスをスキップ (未登録のまま)
      auth.applyStagingBypass('staging-tenant-123')
      expect(auth.isDeviceActivated.value).toBe(false)
      // フラグは 1 回で消費される
      expect(sessionStorage.getItem('alc_skip_staging_bypass')).toBeNull()

      // 次回はバイパスが効く
      auth.applyStagingBypass('staging-tenant-123')
      expect(auth.isDeviceActivated.value).toBe(true)
      expect(auth.deviceTenantId.value).toBe('staging-tenant-123')
    })
  })
})
