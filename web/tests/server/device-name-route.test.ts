// `/api/device-name` (右下の版の表示が自分の端末 1 台の名前を読む口。Refs ippoan/alc-app-s3#352) が、
// 誰を通し、auth-worker へ **実際に何を送るか**・何を返すかを固定する。
//
// - token の判定は版の報告 (`/api/firmware/report`) と同じ (キオスク・運行管理者席) + 管理者
// - `alarm-<指紋>` / `alarm:<指紋>` → shared secret + introspect の tenant で /internal/alarm-keys/label
// - それ以外 → 登録簿 /internal/device-labels から 1 件だけ
// - 見つからない・auth-worker の失敗は name: null の 200
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError, createEvent, defineEventHandler, getHeader, getRequestURL, getResponseHeader,
  setResponseHeader, type H3Event,
} from 'h3'

const SECRET = 'test-internal-shared-secret-32!!'
// 架空の指紋 (本番の機体ではない)
const FP = '0123456789abcdef'

function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}
const KIOSK_JWT = jwt({ sub: 'k1', tenant_id: 't1', role: 'device-kiosk' })
const claimsOf = (role: string) => ({ active: true, tenant_id: 't1', role, sub: 'k1' })

type Handler = (event: H3Event) => Promise<unknown>
let route: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let introspect: { claims: unknown, status: number }
let keyLabel: (() => Response) | { json: unknown, status: number }
let registry: (() => Response) | { json: unknown, status: number }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  route = (await import('../../server/api/device-name.get')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

function respond(r: (() => Response) | { json: unknown, status: number }): Response {
  return typeof r === 'function' ? r() : new Response(JSON.stringify(r.json), { status: r.status })
}

beforeEach(() => {
  introspect = { claims: claimsOf('device-kiosk'), status: 200 }
  keyLabel = { json: { fingerprint: FP, label: '事務所の指静脈', revoked: false }, status: 200 }
  registry = { json: { devices: [{ device_id: 'cores3-a', label: 'ロビー' }, { device_id: 'cores3-b', label: '倉庫' }] }, status: 200 }
  authWorkerFetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/auth/introspect') return new Response(JSON.stringify(introspect.claims), { status: introspect.status })
    if (path === '/internal/alarm-keys/label') return respond(keyLabel)
    if (path === '/internal/device-labels') return respond(registry)
    return new Response('not found', { status: 404 })
  })
})

function event(deviceId: string | null, bearer: string | null = KIOSK_JWT): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = deviceId === null ? '/api/device-name' : `/api/device-name?device_id=${encodeURIComponent(deviceId)}`
  req.headers.host = 'alc.example.test'
  if (bearer) req.headers.authorization = `Bearer ${bearer}`
  const ev = createEvent(req, new ServerResponse(req))
  ev.context.cloudflare = {
    env: { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: vi.fn() } },
  }
  return ev
}

/** introspect 以外に auth-worker へ届いた要求 */
function calls(): Array<[URL, { method: string, headers: Record<string, string> }]> {
  return (authWorkerFetch.mock.calls as Array<[string, { method: string, headers: Record<string, string> }]>)
    .map(([url, init]) => [new URL(url), init] as [URL, { method: string, headers: Record<string, string> }])
    .filter(([url]) => url.pathname !== '/auth/introspect')
}

describe('GET /api/device-name', () => {
  it('★ alarm-<指紋> → shared secret + introspect の tenant と指紋で鍵の名前の口へ。名前だけ返す (no-store)', async () => {
    const ev = event(`alarm-${FP}`)
    expect(await route(ev)).toEqual({ device_id: `alarm-${FP}`, name: '事務所の指静脈' })
    const c = calls()
    expect(c).toHaveLength(1)
    const [url, init] = c[0]!
    expect(url.pathname).toBe('/internal/alarm-keys/label')
    expect(url.searchParams.get('tenant_id')).toBe('t1')
    expect(url.searchParams.get('fingerprint')).toBe(FP)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ Authorization: SECRET })
    expect(getResponseHeader(ev, 'Content-Type')).toBe('application/json')
    expect(getResponseHeader(ev, 'Cache-Control')).toBe('no-store')
  })

  it('alarm:<指紋> (token の sub の形) も同じ口。失効は「 (失効)」を付ける', async () => {
    keyLabel = { json: { fingerprint: FP, label: '旧端末', revoked: true }, status: 200 }
    expect(await route(event(`alarm:${FP}`))).toEqual({ device_id: `alarm:${FP}`, name: '旧端末 (失効)' })
  })

  it.each([
    ['404 (鍵が無い)', { json: { error: 'not_found' }, status: 404 }],
    ['500', { json: {}, status: 500 }],
    ['label が null', { json: { fingerprint: FP, label: null, revoked: false }, status: 200 }],
    ['本文が JSON でない', () => new Response('x', { status: 200 })],
    ['fetch が投げる', () => { throw new Error('down') }],
  ] as const)('鍵の名前が取れない (%s) → name: null の 200', async (_, r) => {
    keyLabel = r as typeof keyLabel
    expect(await route(event(`alarm-${FP}`))).toEqual({ device_id: `alarm-${FP}`, name: null })
  })

  it('★ それ以外 → 登録簿から その 1 件だけ (他の端末の名前は返さない)', async () => {
    const res = await route(event('cores3-a'))
    expect(res).toEqual({ device_id: 'cores3-a', name: 'ロビー' })
    expect(JSON.stringify(res)).not.toContain('倉庫')
    const [url, init] = calls()[0]!
    expect(url.pathname).toBe('/internal/device-labels')
    expect(url.searchParams.get('tenant_id')).toBe('t1')
    expect(url.searchParams.has('all')).toBe(false)
    expect(init.headers).toEqual({ Authorization: SECRET })
  })

  it('登録簿に無い・登録簿が取れない → name: null の 200', async () => {
    expect(await route(event('cores3-z'))).toEqual({ device_id: 'cores3-z', name: null })
    registry = { json: {}, status: 503 }
    expect(await route(event('cores3-a'))).toEqual({ device_id: 'cores3-a', name: null })
  })

  it.each(['device-kiosk', 'device-tenko-manager', 'admin'])('★ %s の token は通す', async (role) => {
    introspect = { claims: claimsOf(role), status: 200 }
    expect(await route(event('cores3-a'))).toEqual({ device_id: 'cores3-a', name: 'ロビー' })
  })

  it('★ token 無しは 401、無効な token は 401、ほかの role は 403 (auth-worker の名前の口は呼ばない)', async () => {
    await expect(route(event('cores3-a', null))).rejects.toMatchObject({ statusCode: 401 })
    introspect = { claims: { active: false }, status: 200 }
    await expect(route(event('cores3-a'))).rejects.toMatchObject({ statusCode: 401 })
    for (const role of ['viewer', 'member', 'device-bp-station']) {
      introspect = { claims: claimsOf(role), status: 200 }
      await expect(route(event('cores3-a'))).rejects.toMatchObject({ statusCode: 403, statusMessage: 'この token では端末の名前を読めません' })
    }
    expect(calls()).toHaveLength(0)
  })

  it.each([null, '', 'alarm-xyz', 'a b'])('device_id が無い・形が違う (%s) は 400', async (id) => {
    await expect(route(event(id))).rejects.toMatchObject({ statusCode: 400 })
    expect(calls()).toHaveLength(0)
  })
})
