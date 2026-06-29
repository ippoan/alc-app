import { describe, it, expect } from 'vitest'
import { buildAlcProxyForward } from '../../server/utils/device-proxy'
import { buildPairInternalForward } from '../../server/utils/device-pairing'

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
  it('/device/pair-internal に X-Internal-Shared-Secret + tenant_id を載せ、role 既定は device-uploader', () => {
    const { url, init } = buildPairInternalForward({
      sharedSecret: SECRET,
      tenantId: 'tenant-9',
      label: 'alc-tablet',
    })
    expect(url).toBe('https://auth-internal.internal/device/pair-internal')
    const h = init.headers as Record<string, string>
    expect(h['X-Internal-Shared-Secret']).toBe(SECRET)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.tenant_id).toBe('tenant-9')
    expect(body.label).toBe('alc-tablet')
    expect(body.role).toBe('device-uploader')
  })

  it('role を明示できる', () => {
    const { init } = buildPairInternalForward({
      sharedSecret: SECRET,
      tenantId: 't',
      label: 'l',
      role: 'device-kiosk',
    })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.role).toBe('device-kiosk')
  })
})
