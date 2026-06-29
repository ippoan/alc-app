import { describe, it, expect } from 'vitest'
import { buildInternalProxyForward } from '../../server/utils/internal-proxy'

const SECRET = 'test-internal-shared-secret-32!!'

describe('buildInternalProxyForward (rust-alc-api#434 caller #5, public-ingest forward)', () => {
  it('path を /alc-internal-proxy<rustPath> に組み立て、consumer proof secret を載せる', () => {
    const { url, init } = buildInternalProxyForward({
      sharedSecret: SECRET,
      rustPath: '/api/tenko-call/register',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ call_number: '001' }),
    })
    expect(url).toBe('https://alc-internal-proxy.internal/alc-internal-proxy/api/tenko-call/register')
    const h = init.headers as Record<string, string>
    expect(h['X-Alc-Proxy-Secret']).toBe(SECRET)
    expect(h['Content-Type']).toBe('application/json')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ call_number: '001' }))
  })

  it('identity ヘッダー (X-Tenant-ID 等) は載せない (public-ingest、詐称防止)', () => {
    const { init } = buildInternalProxyForward({
      sharedSecret: SECRET,
      rustPath: '/api/devices/register/claim',
      method: 'POST',
    })
    const h = init.headers as Record<string, string>
    expect(h['X-Tenant-ID']).toBeUndefined()
    expect(h['Authorization']).toBeUndefined()
    expect(h['X-User-ID']).toBeUndefined()
  })

  it('contentType / body 省略時はヘッダー・body を付けない', () => {
    const { init } = buildInternalProxyForward({
      sharedSecret: SECRET,
      rustPath: '/api/tenko-call/tenko',
      method: 'POST',
    })
    const h = init.headers as Record<string, string>
    expect(h['Content-Type']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('search query を維持する', () => {
    const { url } = buildInternalProxyForward({
      sharedSecret: SECRET,
      rustPath: '/api/tenko-call/register',
      method: 'POST',
      search: '?x=1',
    })
    expect(url).toBe('https://alc-internal-proxy.internal/alc-internal-proxy/api/tenko-call/register?x=1')
  })
})
