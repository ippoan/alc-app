import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DRIVER_MASTER_SYNC_ROLES,
  buildDriverMasterRunForward,
  decideDriverMasterAccess,
} from '../../server/utils/driver-master-sync'

const SECRET = 'test-internal-shared-secret-32!!'

describe('decideDriverMasterAccess (乗務員マスタ同期 #125、introspect 結果の認可判定)', () => {
  it('inactive → 401', () => {
    expect(decideDriverMasterAccess({ active: false, tenant_id: 't1', role: 'admin' })).toEqual({
      ok: false,
      status: 401,
      message: 'token が無効です',
    })
  })

  it('active でも tenant_id 無し → 401', () => {
    expect(decideDriverMasterAccess({ active: true, role: 'admin' })).toMatchObject({ ok: false, status: 401 })
    expect(decideDriverMasterAccess({ active: true, tenant_id: '', role: 'admin' })).toMatchObject({ ok: false, status: 401 })
  })

  it('role が viewer (閲覧者) → 403', () => {
    expect(decideDriverMasterAccess({ active: true, tenant_id: 't1', role: 'viewer' })).toEqual({
      ok: false,
      status: 403,
      message: '乗務員マスタ同期は管理者のみ実行できます',
    })
  })

  it('role 欠落 / 文字列以外 → 403', () => {
    expect(decideDriverMasterAccess({ active: true, tenant_id: 't1' })).toMatchObject({ ok: false, status: 403 })
    expect(decideDriverMasterAccess({ active: true, tenant_id: 't1', role: 1 as unknown as string })).toMatchObject({
      ok: false,
      status: 403,
    })
  })

  it('admin → ok、tenant_id は introspect の値', () => {
    expect(decideDriverMasterAccess({ active: true, tenant_id: 'tenant-9', role: 'admin' })).toEqual({
      ok: true,
      tenantId: 'tenant-9',
    })
  })

  it('許可 role の集合は admin だけ', () => {
    expect([...DRIVER_MASTER_SYNC_ROLES]).toEqual(['admin'])
  })
})

describe('buildDriverMasterRunForward', () => {
  it('/kintai-relay/driver-master-run に POST、X-Alc-Proxy-Secret と {tenant_id} だけを載せる', () => {
    const { url, init } = buildDriverMasterRunForward({ sharedSecret: SECRET, tenantId: 'tenant-9' })
    expect(url).toBe('https://scraper-relay.internal/kintai-relay/driver-master-run')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h['X-Alc-Proxy-Secret']).toBe(SECRET)
    expect(h['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ tenant_id: 'tenant-9' })
  })
})

describe('server/api/driver-master/run.post.ts (route 本体の不変条件)', () => {
  const src = readFileSync(resolve(__dirname, '../../server/api/driver-master/run.post.ts'), 'utf-8')

  it('ブラウザからの body / query を読まない (tenant_id は introspect 由来のみ)', () => {
    expect(src).not.toMatch(/readBody|readRawBody|getQuery|getRouterParam/)
    expect(src).toContain('decideDriverMasterAccess(await introRes.json())')
    expect(src).toContain('tenantId: access.tenantId')
  })

  it('SCRAPER_RELAY / AUTH_WORKER / INTERNAL_SHARED_SECRET の binding を使い、secret を応答に載せない', () => {
    expect(src).toContain('env.SCRAPER_RELAY')
    expect(src).toContain('env.AUTH_WORKER')
    expect(src).toContain('env.INTERNAL_SHARED_SECRET')
    expect(src).not.toMatch(/console\.(log|warn|error)/)
  })
})
