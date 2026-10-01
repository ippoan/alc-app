import { describe, it, expect } from 'vitest'
import {
  AUTH_COOKIE_NAME, BEARER_ONLY_COOKIE_NAME, isDevDeviceBearer, selectProxyCookieName, selectProxyPrefix,
} from '../../server/utils/proxy-target'

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

// --- dev端末の Bearer (Refs ippoan/alc-app#387) ---
//
// dev端末の記録は `/device-data-proxy` を通ったときだけ dev の印が付く。管理者ログインの
// cookie が残ったブラウザでも、dev端末の Bearer が来たらその Bearer を `/device-data-proxy` へ送る。
// 上の既存の期待 (dev でない device JWT / browser JWT / 壊れた token) は 1 本も変えていない。
describe('dev端末の device JWT (claim dev_device、Refs #387)', () => {
  const DEV_DEVICE_JWT = jwt({ sub: 'd1', tenant_id: 't1', role: 'device-kiosk', aud: 'device', dev_device: true })

  it('isDevDeviceBearer は aud=device かつ dev_device=true のときだけ true', () => {
    expect(isDevDeviceBearer(DEV_DEVICE_JWT)).toBe(true)
    expect(isDevDeviceBearer(DEVICE_JWT)).toBe(false)
    // aud が device でない token に dev_device が載っていても dev端末の Bearer とは扱わない
    expect(isDevDeviceBearer(jwt({ role: 'admin', dev_device: true }))).toBe(false)
    expect(isDevDeviceBearer(jwt({ aud: 'hub', dev_device: true }))).toBe(false)
    // true 以外の値
    expect(isDevDeviceBearer(jwt({ aud: 'device', dev_device: 'true' }))).toBe(false)
    expect(isDevDeviceBearer(jwt({ aud: 'device', dev_device: 1 }))).toBe(false)
    // token 無し・壊れた token
    expect(isDevDeviceBearer(undefined)).toBe(false)
    expect(isDevDeviceBearer(null)).toBe(false)
    expect(isDevDeviceBearer('')).toBe(false)
    expect(isDevDeviceBearer('not-a-jwt')).toBe(false)
    expect(isDevDeviceBearer(`a.${Buffer.from('null').toString('base64url')}.c`)).toBe(false)
  })

  it('★ cookie + dev の Bearer → /device-data-proxy、handler には cookie を読ませない', () => {
    const tokens = { cookieToken: BROWSER_JWT, bearerToken: DEV_DEVICE_JWT }
    expect(selectProxyPrefix(tokens)).toBe('/device-data-proxy')
    expect(selectProxyCookieName(tokens)).toBe(BEARER_ONLY_COOKIE_NAME)
  })

  it('dev の Bearer だけ → /device-data-proxy (cookie が無くても同じ扱い)', () => {
    const tokens = { bearerToken: DEV_DEVICE_JWT }
    expect(selectProxyPrefix(tokens)).toBe('/device-data-proxy')
    expect(selectProxyCookieName(tokens)).toBe(BEARER_ONLY_COOKIE_NAME)
  })

  it('cookie + dev でない device Bearer → 今までどおり /alc-proxy に cookie', () => {
    const tokens = { cookieToken: BROWSER_JWT, bearerToken: DEVICE_JWT }
    expect(selectProxyPrefix(tokens)).toBe('/alc-proxy')
    expect(selectProxyCookieName(tokens)).toBe(AUTH_COOKIE_NAME)
  })

  it('cookie だけ・Bearer だけ (dev でない)・token 無し → cookie 名は既定のまま', () => {
    expect(selectProxyCookieName({ cookieToken: BROWSER_JWT })).toBe(AUTH_COOKIE_NAME)
    expect(selectProxyCookieName({ bearerToken: DEVICE_JWT })).toBe(AUTH_COOKIE_NAME)
    expect(selectProxyCookieName({ bearerToken: BROWSER_JWT })).toBe(AUTH_COOKIE_NAME)
    expect(selectProxyCookieName({})).toBe(AUTH_COOKIE_NAME)
  })

  it('BEARER_ONLY_COOKIE_NAME は cookie の名前になり得ない (`=` は名前と値の区切り)', () => {
    expect(BEARER_ONLY_COOKIE_NAME).toBe('=')
    expect(AUTH_COOKIE_NAME).toBe('logi_auth_token')
  })
})
