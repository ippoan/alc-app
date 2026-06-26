import { describe, it, expect } from 'vitest'
import {
  DEVICE_ROLE_KIOSK,
  resolveSecret,
  cfEnv,
  bearerToken,
  buildKioskForwardHeaders,
} from '../../server/utils/kiosk-proxy'

describe('kiosk-proxy helpers (#434 B案)', () => {
  it('DEVICE_ROLE_KIOSK は auth-worker の role 文字列と一致', () => {
    expect(DEVICE_ROLE_KIOSK).toBe('device-kiosk')
  })

  describe('resolveSecret', () => {
    it('文字列はそのまま返す', async () => {
      expect(await resolveSecret('plain-secret')).toBe('plain-secret')
    })

    it('Secrets Store binding (.get()) から値を取り出す', async () => {
      const binding = { get: async () => 'from-store' }
      expect(await resolveSecret(binding)).toBe('from-store')
    })

    it('.get() が null/undefined を返したら null', async () => {
      expect(await resolveSecret({ get: async () => null })).toBeNull()
      expect(await resolveSecret({ get: async () => undefined })).toBeNull()
    })

    it('未設定 (undefined/null/数値) は null', async () => {
      expect(await resolveSecret(undefined)).toBeNull()
      expect(await resolveSecret(null)).toBeNull()
      expect(await resolveSecret(123)).toBeNull()
    })
  })

  describe('cfEnv', () => {
    it('event.context.cloudflare.env を返す', () => {
      const env = { AUTH_WORKER: {}, INTERNAL_SHARED_SECRET: 'x' }
      const event = { context: { cloudflare: { env } } } as never
      expect(cfEnv(event)).toBe(env)
    })

    it('cloudflare コンテキストが無ければ空オブジェクト', () => {
      expect(cfEnv({ context: {} } as never)).toEqual({})
    })
  })

  describe('bearerToken', () => {
    it('Bearer prefix を剥がす (大文字小文字無視)', () => {
      expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
      expect(bearerToken('bearer xyz')).toBe('xyz')
    })

    it('Bearer 以外 / 欠落は空文字', () => {
      expect(bearerToken(undefined)).toBe('')
      expect(bearerToken('')).toBe('')
      expect(bearerToken('Basic abc')).toBe('')
    })
  })

  describe('buildKioskForwardHeaders', () => {
    it('検証済み X-Tenant-ID のみ載せる (Authorization / proxy secret は載せない)', () => {
      const headers = buildKioskForwardHeaders({
        contentType: 'application/json',
        tenantId: '11111111-1111-1111-1111-111111111111',
      })
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'X-Tenant-ID': '11111111-1111-1111-1111-111111111111',
      })
      expect(headers).not.toHaveProperty('Authorization')
      expect(headers).not.toHaveProperty('X-Tenant-Proxy-Secret')
    })

    it('contentType 無しなら Content-Type を省く', () => {
      const headers = buildKioskForwardHeaders({ tenantId: 'tid' })
      expect(headers).toEqual({ 'X-Tenant-ID': 'tid' })
    })
  })
})
