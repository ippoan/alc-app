import { describe, it, expect, vi } from 'vitest'
import { buildAlcProxyForward } from '../../server/utils/device-proxy'
import { buildPairInternalForward, mintAndMergeCredential } from '../../server/utils/device-pairing'

const SECRET = 'test-internal-shared-secret-32!!'

describe('buildAlcProxyForward (rust-alc-api#434 caller #5, device/admin JWT 経路)', () => {
  it('path を /alc-proxy<rustPath> に組み立て、JWT を Bearer・consumer proof・origin を載せる', () => {
    const { url, init } = buildAlcProxyForward({
      sharedSecret: SECRET,
      origin: 'https://alc.ippoan.org',
      rustPath: '/api/devices/report-version',
      method: 'PUT',
      token: 'device-jwt-abc',
      contentType: 'application/json',
      body: JSON.stringify({ device_id: 'd1', version_code: 5 }),
    })
    expect(url).toBe('https://alc-proxy.internal/alc-proxy/api/devices/report-version')
    const h = init.headers as Record<string, string>
    expect(h['Authorization']).toBe('Bearer device-jwt-abc')
    expect(h['X-Alc-Proxy-Secret']).toBe(SECRET)
    expect(h['X-Alc-Proxy-Origin']).toBe('https://alc.ippoan.org')
    expect(h['Content-Type']).toBe('application/json')
    expect(init.method).toBe('PUT')
  })

  it('GET (settings) は body 無しで deviceId 埋め込み path を組む', () => {
    const { url, init } = buildAlcProxyForward({
      sharedSecret: SECRET,
      origin: 'https://alc.ippoan.org',
      rustPath: '/api/devices/settings/dev-123',
      method: 'GET',
      token: 'jwt',
    })
    expect(url).toBe('https://alc-proxy.internal/alc-proxy/api/devices/settings/dev-123')
    expect(init.body).toBeUndefined()
  })
})

describe('buildPairInternalForward (rust-alc-api#434 caller #5, claim provisioning)', () => {
  it('/device/pair-internal に X-Internal-Shared-Secret + tenant_id + device_id を載せ、role 既定は device-uploader', () => {
    const { url, init } = buildPairInternalForward({
      sharedSecret: SECRET,
      tenantId: 'tenant-9',
      deviceId: 'dev-1',
      label: 'alc-tablet',
    })
    expect(url).toBe('https://auth-internal.internal/device/pair-internal')
    const h = init.headers as Record<string, string>
    expect(h['X-Internal-Shared-Secret']).toBe(SECRET)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.tenant_id).toBe('tenant-9')
    expect(body.device_id).toBe('dev-1')
    expect(body.label).toBe('alc-tablet')
    expect(body.role).toBe('device-uploader')
  })

  it('role を明示できる', () => {
    const { init } = buildPairInternalForward({
      sharedSecret: SECRET,
      tenantId: 't',
      deviceId: 'd',
      label: 'l',
      role: 'device-kiosk',
    })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.role).toBe('device-kiosk')
  })
})

describe('mintAndMergeCredential (ippoan/auth-worker#544 PR 2/3、tenant_id + device_id が揃った時だけ mint)', () => {
  it('tenant_id と device_id が両方あれば mint し、device_id を body に載せて credential を merge する', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body.tenant_id).toBe('tenant-9')
      expect(body.device_id).toBe('dev-1')
      expect(body.label).toBe('dev-1')
      return new Response(JSON.stringify({ device_id: 'auth-dev-1', device_secret: 'sekrit' }), { status: 200 })
    })
    const res = await mintAndMergeCredential(SECRET, { fetch: fetchMock as unknown as typeof fetch }, {
      success: true,
      tenant_id: 'tenant-9',
      device_id: 'dev-1',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(res).toEqual({
      success: true,
      tenant_id: 'tenant-9',
      device_id: 'dev-1',
      auth_device_id: 'auth-dev-1',
      device_secret: 'sekrit',
    })
  })

  it('device_id が無い応答では mint しない (fetch を呼ばずそのまま返す)', async () => {
    const fetchMock = vi.fn()
    const res = await mintAndMergeCredential(SECRET, { fetch: fetchMock as unknown as typeof fetch }, {
      success: true,
      tenant_id: 'tenant-9',
      device_id: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res).toEqual({ success: true, tenant_id: 'tenant-9', device_id: null })
  })

  it('tenant_id が無い応答では mint しない (fetch を呼ばずそのまま返す、既存)', async () => {
    const fetchMock = vi.fn()
    const res = await mintAndMergeCredential(SECRET, { fetch: fetchMock as unknown as typeof fetch }, {
      success: true,
      tenant_id: null,
      device_id: 'dev-1',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res).toEqual({ success: true, tenant_id: null, device_id: 'dev-1' })
  })
})
