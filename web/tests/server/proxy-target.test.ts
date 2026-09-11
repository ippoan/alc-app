import { describe, it, expect } from 'vitest'
import { selectProxyPrefix } from '../../server/utils/proxy-target'

/** 署名はダミー (振り分けは署名を見ない)。 */
function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

const DEVICE_JWT = jwt({ sub: 'd1', tenant_id: 't1', role: 'device', aud: 'device' })
const BROWSER_JWT = jwt({ sub: 'u1', tenant_id: 't1', email: 'a@example.com', role: 'admin' })

describe('selectProxyPrefix (Refs #227、キオスクの device JWT 振り分け)', () => {
  it('device JWT の Bearer だけ → /device-data-proxy', () => {
    expect(selectProxyPrefix({ bearerToken: DEVICE_JWT })).toBe('/device-data-proxy')
  })

  it('cookie があれば Bearer が device JWT でも /alc-proxy (auth-client は cookie を優先して送る)', () => {
    expect(selectProxyPrefix({ cookieToken: BROWSER_JWT, bearerToken: DEVICE_JWT })).toBe('/alc-proxy')
  })

  it('browser JWT (aud 無し) の Bearer → /alc-proxy', () => {
    expect(selectProxyPrefix({ bearerToken: BROWSER_JWT })).toBe('/alc-proxy')
  })

  it('aud が device 以外 → /alc-proxy', () => {
    expect(selectProxyPrefix({ bearerToken: jwt({ aud: 'hub' }) })).toBe('/alc-proxy')
  })

  it('壊れた token → /alc-proxy', () => {
    expect(selectProxyPrefix({ bearerToken: 'not-a-jwt' })).toBe('/alc-proxy')
    expect(selectProxyPrefix({ bearerToken: 'a.!!!.c' })).toBe('/alc-proxy')
    expect(selectProxyPrefix({ bearerToken: `a.${Buffer.from('[1').toString('base64url')}.c` })).toBe('/alc-proxy')
  })

  it('token 無し → /alc-proxy', () => {
    expect(selectProxyPrefix({})).toBe('/alc-proxy')
    expect(selectProxyPrefix({ cookieToken: null, bearerToken: null })).toBe('/alc-proxy')
    expect(selectProxyPrefix({ cookieToken: '', bearerToken: '' })).toBe('/alc-proxy')
  })
})
