// `/api/cam-host-keys` (録画タブの端末候補に出す機体の鍵) が、誰を通し、auth-worker へ
// **実際に何を送るか**を固定する。admin の JWT だけ・同じ JWT を cookie に載せて
// `/device/setup/alarm-keys` を引き、用途 kiosk (CoreS3) の鍵の sub と label だけを返す。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError, createEvent, defineEventHandler, getHeader, getRequestURL, getResponseHeader,
  getResponseStatus, setResponseHeader, type H3Event,
} from 'h3'
import { buildAlarmKeysForward, parseAlarmKeyNames, parseCamHostKeys } from '../../server/utils/cam-host-keys'

const SECRET = 'test-internal-shared-secret-32!!'
const ADMIN_CLAIMS = { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' }

type Handler = (event: H3Event) => Promise<unknown>
let route: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let introspect: { claims: unknown, status: number }
let keys: { body: string, status: number }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  route = (await import('../../server/api/cam-host-keys.get')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  introspect = { claims: ADMIN_CLAIMS, status: 200 }
  keys = {
    status: 200,
    body: JSON.stringify({ keys: [
      { fingerprint: 'fp-1', sub: 'alarm:fp-1', label: '帯広の拠点 PC', usage: 'kiosk', created_at: 1 },
      { fingerprint: 'fp-2', sub: 'alarm:fp-2', label: '運行管理者席', usage: 'tenko-manager', created_at: 1 },
    ] }),
  }
  authWorkerFetch = vi.fn(async (url: string) => {
    if (new URL(url).pathname === '/auth/introspect') {
      return new Response(JSON.stringify(introspect.claims), { status: introspect.status })
    }
    return new Response(keys.body, { status: keys.status })
  })
})

function event(bearer: string | null = 'admin-jwt'): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/api/cam-host-keys'
  req.headers.host = 'alc.example.test'
  if (bearer) req.headers.authorization = `Bearer ${bearer}`
  const ev = createEvent(req, new ServerResponse(req))
  ev.context.cloudflare = {
    env: { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: vi.fn() } },
  }
  return ev
}

describe('GET /api/cam-host-keys', () => {
  it('★ admin → 同じ JWT を cookie に載せて鍵の一覧を引き、CoreS3 (kiosk) の鍵だけ返す', async () => {
    const ev = event()
    // keys = 担当付け (kiosk だけ) / names = 名前付け (全用途)
    expect(await route(ev)).toEqual({
      keys: [{ device_id: 'alarm:fp-1', label: '帯広の拠点 PC' }],
      names: [
        { device_id: 'alarm:fp-1', label: '帯広の拠点 PC', revoked: false },
        { device_id: 'alarm:fp-2', label: '運行管理者席', revoked: false },
      ],
    })
    const [url, init] = authWorkerFetch.mock.calls[1] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/device/setup/alarm-keys')
    expect(init).toEqual({ method: 'GET', headers: { Cookie: 'logi_auth_token=admin-jwt' } })
    expect(getResponseHeader(ev, 'Cache-Control')).toBe('no-store')
  })

  it('token が無効なら 401、admin でなければ 403 (一覧は引かない)', async () => {
    introspect = { claims: { active: false }, status: 200 }
    await expect(route(event())).rejects.toMatchObject({ statusCode: 401 })
    introspect = { claims: { ...ADMIN_CLAIMS, role: 'device-tenko-manager' }, status: 200 }
    await expect(route(event())).rejects.toMatchObject({ statusCode: 403, statusMessage: '管理者のみ参照できます' })
    expect(authWorkerFetch.mock.calls.every(([u]) => new URL(u as string).pathname === '/auth/introspect')).toBe(true)
  })

  it('Bearer が無ければ 401', async () => {
    await expect(route(event(null))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('一覧の失敗は status と本文をそのまま返す', async () => {
    keys = { status: 401, body: '{"error":"unauthorized"}' }
    const ev = event()
    expect(await route(ev)).toBe('{"error":"unauthorized"}')
    expect(getResponseStatus(ev)).toBe(401)
  })
})

describe('cam-host-keys の純関数', () => {
  it('forward は cookie だけ (shared secret は載せない)', () => {
    expect(buildAlarmKeysForward('t')).toEqual({
      url: 'https://auth-worker.internal/device/setup/alarm-keys',
      init: { method: 'GET', headers: { Cookie: 'logi_auth_token=t' } },
    })
  })
  it('形が違えば空 / sub が無い・空 label は飛ばす・null にする', () => {
    expect(parseCamHostKeys(null)).toEqual([])
    expect(parseCamHostKeys({ keys: 'x' })).toEqual([])
    expect(parseCamHostKeys({ keys: [
      null,
      { usage: 'kiosk' },
      { usage: 'kiosk', sub: '' },
      { usage: 'kiosk', sub: 'alarm:a', label: '' },
      { usage: 'kiosk', sub: 'alarm:b', label: 3 },
    ] })).toEqual([{ device_id: 'alarm:a', label: null }, { device_id: 'alarm:b', label: null }])
  })
  it('名前用は全用途・失効済みまで返し、担当付け用は kiosk / bp-station の鍵だけ', () => {
    const json = { keys: [
      { sub: 'alarm:k', label: 'kiosk', usage: 'kiosk' },
      { sub: 'alarm:b', label: '測定台', usage: 'bp-station' },
      { sub: 'alarm:m', label: '運行管理者席', usage: 'tenko-manager' },
      { sub: 'alarm:v', label: 'VoiceS3R', usage: 'voice', revoked_at: 123 },
      { sub: 'alarm:n', usage: 5, revoked_at: null },
    ] }
    expect(parseAlarmKeyNames(json)).toEqual([
      { device_id: 'alarm:k', label: 'kiosk', revoked: false },
      { device_id: 'alarm:b', label: '測定台', revoked: false },
      { device_id: 'alarm:m', label: '運行管理者席', revoked: false },
      { device_id: 'alarm:v', label: 'VoiceS3R', revoked: true },
      { device_id: 'alarm:n', label: null, revoked: false },
    ])
    expect(parseCamHostKeys(json)).toEqual([{ device_id: 'alarm:k', label: 'kiosk' }, { device_id: 'alarm:b', label: '測定台' }])
    expect(parseAlarmKeyNames(null)).toEqual([])
  })
})
