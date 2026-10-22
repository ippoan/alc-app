// `/api/vein-fleet{,/request,/report}` の route が、誰を通し、auth-worker と recorder へ
// **実際に何を送るか**を固定する (Refs ippoan/alc-app#436)。
//
// - report  … キオスクの端末の token だけ + 端末は token の sub + 登録簿との照合 (fail-closed)
// - list    … admin だけ (dev ログインの token も読める)
// - request … admin だけ (合図は何も書き込まないので dev ログインの token も通す)
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError,
  createEvent,
  defineEventHandler,
  getHeader,
  getRequestURL,
  getResponseHeader,
  getResponseStatus,
  setResponseHeader,
  type H3Event,
} from 'h3'

const SECRET = 'test-internal-shared-secret-32!!'

/** 署名はダミー (route は署名を見ない。検証は introspect = auth-worker)。 */
function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

const KIOSK_JWT = jwt({ sub: 'k1', tenant_id: 't1', role: 'device-kiosk', aud: 'device' })
const ADMIN_JWT = jwt({ sub: 'u1', tenant_id: 't1', role: 'admin' })
const DEV_LOGIN_JWT = jwt({ sub: 'u1', tenant_id: 't1', role: 'admin', token_kind: 'dev' })

const KIOSK_CLAIMS = { active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'k1' }
const ADMIN_CLAIMS = { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' }

type Handler = (event: H3Event) => Promise<unknown>
let report: Handler
let list: Handler
let request: Handler

let authWorkerFetch: ReturnType<typeof vi.fn>
let recorderFetch: ReturnType<typeof vi.fn>
let body: unknown
let readBodyFails: boolean

/** auth-worker の 2 つの口 (introspect / 登録簿) の応答。`labels` に関数を置くと例外も出せる。 */
let introspect: { claims: unknown, status: number }
let labels: (() => Response) | { json: unknown, status: number }

beforeAll(async () => {
  // server route は Nitro の auto-import に乗っているので、h3 の実物を global に置く
  // (setResponseStatus は Nuxt のテスト環境が自前の auto-import で解決するので置かない)。
  // readBody だけは差し替える (IncomingMessage に body を流し込む代わり)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  vi.stubGlobal('readBody', async () => {
    if (readBodyFails) throw new Error('invalid json')
    return body
  })
  report = (await import('../../server/api/vein-fleet/report.post')).default as unknown as Handler
  list = (await import('../../server/api/vein-fleet/index.get')).default as unknown as Handler
  request = (await import('../../server/api/vein-fleet/request.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  body = undefined
  readBodyFails = false
  introspect = { claims: KIOSK_CLAIMS, status: 200 }
  labels = { json: { devices: [{ device_id: 'k1', label: '事務所' }, { device_id: 'd2', label: null }] }, status: 200 }
  authWorkerFetch = vi.fn(async (url: string) => {
    if (new URL(url).pathname === '/auth/introspect') {
      return new Response(JSON.stringify(introspect.claims), { status: introspect.status })
    }
    if (typeof labels === 'function') return labels()
    return new Response(JSON.stringify(labels.json), { status: labels.status })
  })
  recorderFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
})

function makeEvent(
  method: 'GET' | 'POST',
  path: string,
  opts: { bearer?: string, env?: Record<string, unknown>, headers?: Record<string, string> } = {},
): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = path
  req.headers.host = 'alc.example.test'
  const bearer = 'bearer' in opts ? opts.bearer : KIOSK_JWT
  if (bearer) req.headers.authorization = `Bearer ${bearer}`
  Object.assign(req.headers, opts.headers)
  const event = createEvent(req, new ServerResponse(req))
  event.context.cloudflare = {
    env: opts.env ?? {
      INTERNAL_SHARED_SECRET: SECRET,
      AUTH_WORKER: { fetch: authWorkerFetch },
      RECORDER: { fetch: recorderFetch },
    },
  }
  return event
}

type Opts = Parameters<typeof makeEvent>[2]
const reportEvent = (opts?: Opts) => makeEvent('POST', '/api/vein-fleet/report', opts)
const listEvent = (opts?: Opts) => makeEvent('GET', '/api/vein-fleet', { bearer: ADMIN_JWT, ...opts })
const requestEvent = (opts?: Opts) => makeEvent('POST', '/api/vein-fleet/request', { bearer: ADMIN_JWT, ...opts })

/** RECORDER binding の fetch に届いた要求 (1 回だけ)。 */
function forwarded(): { method: string, pathname: string, headers: Record<string, string>, body: string | undefined } {
  expect(recorderFetch).toHaveBeenCalledTimes(1)
  const [url, init] = recorderFetch.mock.calls[0] as [string, { method: string, headers: Record<string, string>, body?: string }]
  return { method: init.method, pathname: new URL(url).pathname, headers: init.headers, body: init.body }
}

/** AUTH_WORKER binding の fetch に届いた登録簿への要求。 */
function labelsCalls(): Array<[string, RequestInit]> {
  return (authWorkerFetch.mock.calls as Array<[string, RequestInit]>).filter(
    ([url]) => new URL(url).pathname === '/internal/device-labels',
  )
}

function expectNoStore(event: H3Event) {
  expect(getResponseHeader(event, 'Content-Type')).toBe('application/json')
  expect(getResponseHeader(event, 'Cache-Control')).toBe('no-store')
}

describe('admin の口 (list / request)', () => {
  it('admin 以外は 403', async () => {
    introspect = { claims: KIOSK_CLAIMS, status: 200 }
    for (const [handler, event] of [[list, listEvent], [request, requestEvent]] as const) {
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 403, statusMessage: '指静脈の一覧は管理者のみ見られます' })
    }
    introspect = { claims: { active: true, role: 'admin' }, status: 200 }
    await expect(list(listEvent())).rejects.toMatchObject({ statusCode: 401 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('list: recorder の一覧に登録簿のラベルを足す (dev ログインの token も通す)', async () => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      devices: [{ device_id: 'k1', entries: [], reported_at_ms: 1 }, { device_id: 'x', entries: [], reported_at_ms: 0 }],
    })))
    const event = listEvent({ bearer: DEV_LOGIN_JWT })
    expect(await list(event)).toEqual({
      devices: [
        { device_id: 'k1', entries: [], reported_at_ms: 1, label: '事務所' },
        { device_id: 'x', entries: [], reported_at_ms: 0, label: null },
      ],
    })
    const f = forwarded()
    expect(f.method).toBe('GET')
    expect(f.pathname).toBe('/tenants/t1/vein-list-status')
    expect(f.headers.Authorization).toBe(SECRET)
    expectNoStore(event)
  })

  it('list: recorder の 200 以外はそのまま返す', async () => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status: 500 }))
    const event = listEvent()
    expect(await list(event)).toBe('{"error":"x"}')
    expect(getResponseStatus(event)).toBe(500)
    expect(labelsCalls()).toHaveLength(0)
  })

  it('request: recorder の合図の口へ空の POST を送り、応答をそのまま返す', async () => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch.mockResolvedValueOnce(new Response('{"sent":2}'))
    const event = requestEvent({ bearer: DEV_LOGIN_JWT })
    expect(await request(event)).toBe('{"sent":2}')
    const f = forwarded()
    expect(f.method).toBe('POST')
    expect(f.pathname).toBe('/tenants/t1/vein-list-request')
    expect(f.body).toBe('{}')
    expect(getResponseStatus(event)).toBe(200)
    expectNoStore(event)
  })
})

describe('キオスクの口 (report)', () => {
  const entries = [{ module_id: 10, employee_id: 'e1', approved: true }]

  it('★ 端末は token の sub で決め、body の device_id は上書きする', async () => {
    body = { device_id: 'd2', entries, module_users: 1 }
    const event = reportEvent()
    expect(await report(event)).toBe('{"ok":true}')
    const f = forwarded()
    expect(f.pathname).toBe('/tenants/t1/vein-list-report')
    expect(JSON.parse(f.body!)).toEqual({ device_id: 'k1', entries, module_users: 1 })
    expectNoStore(event)
  })

  it('キオスク以外は 403、sub の形が外れていたら 400', async () => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 403 })
    introspect = { claims: { ...KIOSK_CLAIMS, sub: 'a b' }, status: 200 }
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: '端末の id がありません' })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('body が無い・配列・壊れていれば 400', async () => {
    for (const b of [undefined, [], 'x']) {
      body = b
      await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'body がありません' })
    }
    readBodyFails = true
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('★ 登録簿が取れなければ 503 (fail-closed)、載っていない端末は 400', async () => {
    body = { entries }
    labels = { json: {}, status: 500 }
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 503 })
    labels = { json: { devices: [{ device_id: 'd2', label: null }] }, status: 200 }
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: '登録されていない端末です' })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('recorder の 400 はそのまま返す', async () => {
    body = { entries: [null] }
    recorderFetch.mockResolvedValueOnce(new Response('{"error":"invalid_entries"}', { status: 400 }))
    const event = reportEvent()
    expect(await report(event)).toBe('{"error":"invalid_entries"}')
    expect(getResponseStatus(event)).toBe(400)
  })
})
