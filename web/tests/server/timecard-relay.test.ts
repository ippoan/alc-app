import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDevLoginToken, tokenKindOf } from '../../server/utils/print-relay'
import {
  BROWSER_DEVICE_ID,
  PUNCH_DEVICE_ROLES,
  buildRecorderTimecardPunchForward,
  decideTimecardPunchAccess,
} from '../../server/utils/timecard-relay'

const SECRET = 'test-internal-shared-secret-32!!'

describe('decideTimecardPunchAccess (ブラウザ打刻 #134、introspect 結果の認可判定)', () => {
  it('inactive → 401', () => {
    expect(decideTimecardPunchAccess({ active: false, tenant_id: 't1', role: 'admin' })).toEqual({
      ok: false,
      status: 401,
      message: 'token が無効です',
    })
  })

  it('active でも tenant_id 無し → 401', () => {
    expect(decideTimecardPunchAccess({ active: true, role: 'admin' })).toMatchObject({ ok: false, status: 401 })
    expect(decideTimecardPunchAccess({ active: true, tenant_id: '', role: 'admin' })).toMatchObject({ ok: false, status: 401 })
  })

  it('★ キオスク以外の device role (印刷ブリッジ / ハブ / GW) は 403', () => {
    // 端末の資格情報が盗まれても打刻を捏造できないようにする
    for (const role of ['device-print', 'device-hub', 'device-gateway', 'device-timecard']) {
      expect(decideTimecardPunchAccess({ active: true, tenant_id: 't1', role, sub: 'dev-1' })).toEqual({
        ok: false,
        status: 403,
        message: 'この端末では打刻できません',
      })
    }
  })

  it('キオスクの device JWT → device_id は sub (どの端末で打ったかが残る)', () => {
    expect(
      decideTimecardPunchAccess({ active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'kiosk-7' }),
    ).toEqual({ ok: true, tenantId: 't1', deviceId: 'kiosk-7' })
  })

  it('device role なのに sub 欠落 → 401 (fail-closed)', () => {
    expect(
      decideTimecardPunchAccess({ active: true, tenant_id: 't1', role: 'device-kiosk' }),
    ).toMatchObject({ ok: false, status: 401 })
  })

  it('★ 利用者の browser JWT は role を問わず ok、device_id は browser', () => {
    // 切り替え前は X-Tenant-ID だけで通っていた経路。ここで user role の
    // allowlist を発明すると、名前を知らない role の利用者が現場で打てなくなる
    for (const role of ['admin', 'manager', 'viewer', 'user', undefined]) {
      expect(decideTimecardPunchAccess({ active: true, tenant_id: 't9', role, sub: 'u-1' })).toEqual({
        ok: true,
        tenantId: 't9',
        deviceId: BROWSER_DEVICE_ID,
      })
    }
  })

  it('device_id の既定値は rust 側 create_punch と同じ文字列', () => {
    // 経路の切り替え前後で打刻履歴の「端末」列が割れないようにする
    expect(BROWSER_DEVICE_ID).toBe('browser')
  })

  it('打刻できる device role の集合はキオスクだけ', () => {
    expect([...PUNCH_DEVICE_ROLES]).toEqual(['device-kiosk'])
  })
})

describe('buildRecorderTimecardPunchForward', () => {
  it('recorder の timecard-punch へ POST、shared secret と {card_id} だけを載せる', () => {
    const { url, init } = buildRecorderTimecardPunchForward({
      sharedSecret: SECRET,
      tenantId: 'tenant-9',
      deviceId: 'kiosk-7',
      cardId: 'ABCD1234',
    })
    expect(url).toBe('https://alc-recorder.internal/tenants/tenant-9/devices/kiosk-7/timecard-punch')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe(SECRET)
    expect(h['Content-Type']).toBe('application/json')
    // **kind / seq は送らない** (recorder 側が立てる)
    expect(JSON.parse(init.body as string)).toEqual({ card_id: 'ABCD1234' })
  })

  it('tenantId / deviceId は URL エンコードする', () => {
    const { url } = buildRecorderTimecardPunchForward({
      sharedSecret: SECRET,
      tenantId: 'a/b',
      deviceId: 'c d',
      cardId: 'X',
    })
    expect(url).toBe('https://alc-recorder.internal/tenants/a%2Fb/devices/c%20d/timecard-punch')
  })
})

/** テスト用の JWT を組む (署名は使わないので固定文字列)。 */
function jwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
}

describe('tokenKindOf / isDevLoginToken (検証セッションの書き込みを弾く、Refs ippoan/alc-app#162)', () => {
  it('dev-login の JWT を見分ける', () => {
    expect(tokenKindOf(jwt({ sub: 'u1', token_kind: 'dev' }))).toBe('dev')
    expect(isDevLoginToken(jwt({ sub: 'u1', token_kind: 'dev' }))).toBe(true)
  })

  it('通常の browser JWT は dev ではない (token_kind が無い)', () => {
    expect(tokenKindOf(jwt({ sub: 'u1', role: 'admin' }))).toBeNull()
    expect(isDevLoginToken(jwt({ sub: 'u1', role: 'admin' }))).toBe(false)
  })

  it('非 ASCII の claim があっても payload を読める (UTF-8)', () => {
    // atob をそのまま JSON.parse すると氏名などで壊れる
    expect(tokenKindOf(jwt({ name: '本多 優鷹', token_kind: 'dev' }))).toBe('dev')
  })

  it('token_kind が文字列でなければ null', () => {
    expect(tokenKindOf(jwt({ token_kind: 1 }))).toBeNull()
  })

  it('読めない token は null (dev 扱いにしない = introspect を通ったものしか来ない)', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.@@@.c', `a.${Buffer.from('not json').toString('base64url')}.c`]) {
      expect(tokenKindOf(bad)).toBeNull()
      expect(isDevLoginToken(bad)).toBe(false)
    }
  })
})

describe('server/api/timecard/punch.post.ts (route 本体の不変条件)', () => {
  const src = readFileSync(resolve(__dirname, '../../server/api/timecard/punch.post.ts'), 'utf-8')

  it('★ tenant_id / device_id は introspect 由来のみ (body からは card_id しか読まない)', () => {
    expect(src).toContain('decideTimecardPunchAccess(await introRes.json())')
    expect(src).toContain('tenantId: access.tenantId')
    expect(src).toContain('deviceId: access.deviceId')
    expect(src).not.toMatch(/body\?\.(tenant_id|device_id)/)
    expect(src).not.toMatch(/getQuery|getRouterParam/)
  })

  it('★ dev-login の token では打刻を書かせない (検証セッションが本番を変えない)', () => {
    // auth-worker の read-only enforcement (#433) は /alc-proxy の中にあり、
    // 自前 introspect のこの route には効かない (Refs ippoan/alc-app#162)
    expect(src).toContain('isDevLoginToken(token)')
    expect(src).toContain('dev_token_write_forbidden')
    // 弾くのは introspect (= 署名検証) を通った後であること
    expect(src.indexOf('decideTimecardPunchAccess')).toBeLessThan(src.indexOf('isDevLoginToken(token)'))
    // recorder へ転送する前であること
    expect(src.indexOf('isDevLoginToken(token)')).toBeLessThan(src.indexOf('buildRecorderTimecardPunchForward({'))
  })

  it('RECORDER / AUTH_WORKER / INTERNAL_SHARED_SECRET の binding を使い、secret を応答に載せない', () => {
    expect(src).toContain('env.RECORDER')
    expect(src).toContain('env.AUTH_WORKER')
    expect(src).toContain('env.INTERNAL_SHARED_SECRET')
    expect(src).not.toMatch(/console\.(log|warn|error)/)
  })
})
