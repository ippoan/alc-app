// `GET /api/timecard/punches/csv` が、backend の CSV を (同じ認証のまま) 取り、デバイス列だけ名前に替えて返すことを固定する。
// 名前は呼び手が admin のときだけ引く。引けなくても CSV は返す。backend の失敗は素通し。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError, createEvent, defineEventHandler, getHeader, getRequestURL, getResponseHeader,
  getResponseStatus, setResponseHeader, type H3Event,
} from 'h3'

const SECRET = 'test-internal-shared-secret-32!!'
const ADMIN_CLAIMS = { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' }
const HEADER = 'ID,区分,カード,社員コード,社員名,打刻日時,デバイス,測定ID,アルコール値,判定,点呼記録'
const BACKEND_CSV = `﻿${HEADER}\n1,打刻,IC,001,山田,2026-10-24 09:00:00,alarm:fp-1,,,,\n2,打刻,IC,001,山田,2026-10-24 09:01:00,cores3-a,,,,\n3,打刻,IC,001,山田,2026-10-24 09:02:00,browser,,,,\n4,打刻,IC,001,山田,2026-10-24 09:03:00,cores3-z,,,,\n`

type Handler = (event: H3Event) => Promise<unknown>
let route: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let backendFetch: ReturnType<typeof vi.fn>
let introspect: { claims: unknown, status: number }
let keys: { body: string, status: number }
let labels: { body: string, status: number }
let backend: { status: number, body: BodyInit }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  route = (await import('../../server/api/timecard/punches/csv.get')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  introspect = { claims: ADMIN_CLAIMS, status: 200 }
  keys = { status: 200, body: JSON.stringify({ keys: [{ sub: 'alarm:fp-1', label: '帯広の拠点 PC', usage: 'kiosk' }] }) }
  labels = { status: 200, body: JSON.stringify({ devices: [{ device_id: 'cores3-a', label: '旧ハブ' }] }) }
  backend = {
    status: 200,
    body: new TextEncoder().encode(BACKEND_CSV),
  }
  authWorkerFetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/auth/introspect') return new Response(JSON.stringify(introspect.claims), { status: introspect.status })
    if (path === '/device/setup/alarm-keys') return new Response(keys.body, { status: keys.status })
    return new Response(labels.body, { status: labels.status })
  })
  backendFetch = vi.fn(async () => new Response(backend.body, {
    status: backend.status,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="time_punches.csv"' },
  }))
})

function event(bearer: string | null = 'admin-jwt', search = '?date_from=2026-10-24'): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = `/api/timecard/punches/csv${search}`
  req.headers.host = 'alc.example.test'
  if (bearer) req.headers.authorization = `Bearer ${bearer}`
  const ev = createEvent(req, new ServerResponse(req))
  ev.context.cloudflare = {
    env: { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: vi.fn() } },
  }
  ;(ev as unknown as { fetch: unknown }).fetch = backendFetch
  return ev
}

describe('GET /api/timecard/punches/csv', () => {
  it('★ backend の CSV を proxy 経由で取り (クエリそのまま)、デバイス列だけ名前に替える。他は変えない', async () => {
    const ev = event()
    const out = await route(ev)
    expect(out).toBe(
      `﻿${HEADER}\n1,打刻,IC,001,山田,2026-10-24 09:00:00,帯広の拠点 PC,,,,\n`
      + '2,打刻,IC,001,山田,2026-10-24 09:01:00,旧ハブ (鍵の ID 未登録),,,,\n'
      + '3,打刻,IC,001,山田,2026-10-24 09:02:00,ブラウザ (ログイン利用者の打刻),,,,\n'
      + '4,打刻,IC,001,山田,2026-10-24 09:03:00,名前未登録の端末,,,,\n',
    )
    expect(backendFetch).toHaveBeenCalledWith('/api/proxy/timecard/punches/csv?date_from=2026-10-24', { method: 'GET' })
    expect(getResponseStatus(ev)).toBe(200)
    // 種類・保存名は backend のまま
    expect(getResponseHeader(ev, 'content-type')).toBe('text/csv; charset=utf-8')
    expect(getResponseHeader(ev, 'content-disposition')).toBe('attachment; filename="time_punches.csv"')
    expect(getResponseHeader(ev, 'Cache-Control')).toBe('no-store')
    // 鍵の一覧は呼び手の JWT を cookie に載せて引く (cam-host-keys と同じ経路)
    const keysCall = authWorkerFetch.mock.calls.find(([u]) => new URL(u as string).pathname === '/device/setup/alarm-keys')!
    expect(keysCall[1]).toEqual({ method: 'GET', headers: { Cookie: 'logi_auth_token=admin-jwt' } })
  })

  it('backend の失敗 (403 など) は status と本文をそのまま返し、名前は引かない', async () => {
    backend = { status: 403, body: 'forbidden' }
    const ev = event()
    expect(await route(ev)).toBe('forbidden')
    expect(getResponseStatus(ev)).toBe(403)
    expect(authWorkerFetch).not.toHaveBeenCalled()
  })

  it('admin でない・Bearer が無い・introspect が失敗・鍵の一覧が取れない → 名前を引けないだけで元の CSV を返す', async () => {
    introspect = { claims: { ...ADMIN_CLAIMS, role: 'device-kiosk' }, status: 200 }
    expect(await route(event())).toBe(BACKEND_CSV)
    introspect = { claims: ADMIN_CLAIMS, status: 500 }
    expect(await route(event())).toBe(BACKEND_CSV)
    expect(await route(event(null))).toBe(BACKEND_CSV)
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    keys = { status: 403, body: '{}' }
    expect(await route(event())).toBe(BACKEND_CSV)
  })

  it('登録簿だけ取れなくても鍵の名前は使う (結び付きの無い hub は名前未登録)', async () => {
    labels = { status: 500, body: '{}' }
    const out = await route(event()) as string
    expect(out).toContain('帯広の拠点 PC')
    expect(out).toContain('2026-10-24 09:01:00,名前未登録の端末,')
  })

  it('クエリが無くても通る', async () => {
    await route(event('admin-jwt', ''))
    expect(backendFetch).toHaveBeenCalledWith('/api/proxy/timecard/punches/csv', { method: 'GET' })
  })

  it('content-type / content-disposition が無い応答でも通る', async () => {
    backendFetch.mockResolvedValue(new Response(BACKEND_CSV, { status: 200 }))
    const ev = event()
    expect(typeof await route(ev)).toBe('string')
  })
})
