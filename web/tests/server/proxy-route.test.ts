// `/api/proxy/*` の route が auth-worker へ**実際に送る prefix とトークン**を固定する
// (Refs ippoan/alc-app#387)。
//
// 振り分けの純関数 (proxy-target.ts) だけでは足りない — 送るトークンを決めているのは
// `@ippoan/auth-client` の `createAuthWorkerProxyHandler` (cookie を Bearer より優先) なので、
// **handler は本物のまま** route を通し、AUTH_WORKER binding の fetch に届いた URL と
// Authorization を見る。パッケージ側の cookie / Bearer の扱いが変わればここが落ちる。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createError, createEvent, defineEventHandler, getCookie, getHeader, type H3Event } from 'h3'
import { AUTH_COOKIE_NAME, BEARER_ONLY_COOKIE_NAME } from '../../server/utils/proxy-target'

const SECRET = 'test-internal-shared-secret-32!!'

/** 署名はダミー (route も handler も署名を見ない。検証は auth-worker)。 */
function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

const BROWSER_JWT = jwt({ sub: 'u1', tenant_id: 't1', email: 'a@example.com', role: 'admin' })
const DEVICE_JWT = jwt({ sub: 'd1', tenant_id: 't1', role: 'device-kiosk', aud: 'device' })
const DEV_DEVICE_JWT = jwt({ sub: 'd2', tenant_id: 't1', role: 'device-kiosk', aud: 'device', dev_device: true })

type Handler = (event: H3Event) => Promise<unknown>
let handler: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>

beforeAll(async () => {
  // server route は Nitro の auto-import (defineEventHandler 等) に乗っているので、
  // テストでは h3 の実物をそのまま global に置く
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getCookie', getCookie)
  vi.stubGlobal('getHeader', getHeader)
  handler = (await import('../../server/api/proxy/[...path]')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  authWorkerFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
})

/** route に渡す event を組む (GET /api/proxy/<path>)。 */
function makeEvent(opts: { cookie?: string, bearer?: string, path?: string, env?: Record<string, unknown> }): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = `/api/proxy/${opts.path ?? 'tenko/sessions'}`
  req.headers.host = 'alc.example.test'
  if (opts.cookie) req.headers.cookie = opts.cookie
  if (opts.bearer) req.headers.authorization = `Bearer ${opts.bearer}`
  const event = createEvent(req, new ServerResponse(req))
  event.context.params = { path: opts.path ?? 'tenko/sessions' }
  event.context.cloudflare = {
    env: opts.env ?? { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch } },
  }
  return event
}

/** AUTH_WORKER binding の fetch に届いた [pathname, Authorization]。 */
function forwarded(): { pathname: string, authorization: string | undefined, secret: string | undefined } {
  expect(authWorkerFetch).toHaveBeenCalledTimes(1)
  const [url, init] = authWorkerFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
  return {
    pathname: new URL(url).pathname,
    authorization: init.headers.Authorization,
    secret: init.headers['X-Alc-Proxy-Secret'],
  }
}

describe('/api/proxy/* が auth-worker へ送る prefix とトークン (Refs #387)', () => {
  it('★ cookie + dev の Bearer → /device-data-proxy に **Bearer** (cookie の browser JWT は送らない)', async () => {
    await handler(makeEvent({ cookie: `${AUTH_COOKIE_NAME}=${BROWSER_JWT}`, bearer: DEV_DEVICE_JWT }))

    expect(forwarded()).toEqual({
      pathname: '/device-data-proxy/api/tenko/sessions',
      authorization: `Bearer ${DEV_DEVICE_JWT}`,
      secret: SECRET,
    })
  })

  it('dev の Bearer だけ → /device-data-proxy に Bearer', async () => {
    await handler(makeEvent({ bearer: DEV_DEVICE_JWT }))

    expect(forwarded()).toMatchObject({
      pathname: '/device-data-proxy/api/tenko/sessions',
      authorization: `Bearer ${DEV_DEVICE_JWT}`,
    })
  })

  it('cookie + dev でない device Bearer → 今までどおり /alc-proxy に cookie の token', async () => {
    await handler(makeEvent({ cookie: `${AUTH_COOKIE_NAME}=${BROWSER_JWT}`, bearer: DEVICE_JWT }))

    expect(forwarded()).toMatchObject({
      pathname: '/alc-proxy/api/tenko/sessions',
      authorization: `Bearer ${BROWSER_JWT}`,
    })
  })

  it('cookie だけ → 今までどおり /alc-proxy に cookie の token', async () => {
    await handler(makeEvent({ cookie: `${AUTH_COOKIE_NAME}=${BROWSER_JWT}` }))

    expect(forwarded()).toMatchObject({
      pathname: '/alc-proxy/api/tenko/sessions',
      authorization: `Bearer ${BROWSER_JWT}`,
    })
  })

  it('dev でない device Bearer だけ → 今までどおり /device-data-proxy に Bearer', async () => {
    await handler(makeEvent({ bearer: DEVICE_JWT }))

    expect(forwarded()).toMatchObject({
      pathname: '/device-data-proxy/api/tenko/sessions',
      authorization: `Bearer ${DEVICE_JWT}`,
    })
  })

  it('browser JWT の Bearer だけ → 今までどおり /alc-proxy に Bearer', async () => {
    await handler(makeEvent({ bearer: BROWSER_JWT }))

    expect(forwarded()).toMatchObject({
      pathname: '/alc-proxy/api/tenko/sessions',
      authorization: `Bearer ${BROWSER_JWT}`,
    })
  })

  it('`=` という名前の cookie は作れないので、dev の Bearer のとき cookie 側の値が送られることは無い', async () => {
    // 「名前が空・値が `=...`」や「`=` を含む値」をどう並べても、handler が読むのは Bearer
    const cookie = [
      `${AUTH_COOKIE_NAME}=${BROWSER_JWT}`,
      `==${BROWSER_JWT}`,
      `${BEARER_ONLY_COOKIE_NAME}=${BROWSER_JWT}`,
    ].join('; ')
    await handler(makeEvent({ cookie, bearer: DEV_DEVICE_JWT }))

    expect(forwarded().authorization).toBe(`Bearer ${DEV_DEVICE_JWT}`)
  })

  it('binding が無ければ 503 (従来どおり)', async () => {
    await expect(handler(makeEvent({ bearer: DEV_DEVICE_JWT, env: {} })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(handler(makeEvent({ bearer: DEV_DEVICE_JWT, env: { INTERNAL_SHARED_SECRET: SECRET } })))
      .rejects.toMatchObject({ statusCode: 503 })
  })
})
