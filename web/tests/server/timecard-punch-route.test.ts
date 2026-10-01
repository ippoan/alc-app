// `POST /api/timecard/punch` の route が recorder へ**実際に送る要求**を固定する
// (Refs ippoan/alc-app#387)。
//
// dev端末 (開発用の鍵) の打刻かどうかは、auth-worker の introspect が返す
// `dev_device === true` だけで決まる。route はそれを `X-Device-Dev: 1` で recorder に
// 伝え、dev でなければヘッダー自体を付けない。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError,
  createEvent,
  defineEventHandler,
  getHeader,
  getRequestURL,
  setResponseHeader,
  type H3Event,
} from 'h3'

const SECRET = 'test-internal-shared-secret-32!!'

/** 署名はダミー (route は署名を見ない。検証は introspect = auth-worker)。 */
function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

const KIOSK_JWT = jwt({ sub: 'd1', tenant_id: 't1', role: 'device-kiosk', aud: 'device' })
const DEV_LOGIN_JWT = jwt({ sub: 'u1', tenant_id: 't1', role: 'admin', token_kind: 'dev' })

type Handler = (event: H3Event) => Promise<unknown>
let handler: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let recorderFetch: ReturnType<typeof vi.fn>
let body: unknown

beforeAll(async () => {
  // server route は Nitro の auto-import に乗っているので、h3 の実物を global に置く
  // (setResponseStatus は Nuxt のテスト環境が自前の auto-import で解決するので置かない)。
  // readBody だけは差し替える (IncomingMessage に body を流し込む代わり)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  vi.stubGlobal('readBody', async () => body)
  handler = (await import('../../server/api/timecard/punch.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/** introspect の応答を差し替える。 */
function introspectReturns(claims: Record<string, unknown>, status = 200) {
  authWorkerFetch = vi.fn(async () => new Response(JSON.stringify(claims), { status }))
}

beforeEach(() => {
  body = { card_id: 'CARD-1' }
  introspectReturns({ active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'd1' })
  recorderFetch = vi.fn(async () => new Response(JSON.stringify({ seq: 1 }), { status: 202 }))
})

function makeEvent(opts: { bearer?: string, clientDevHeader?: string, env?: Record<string, unknown> } = {}): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = '/api/timecard/punch'
  req.headers.host = 'alc.example.test'
  const bearer = 'bearer' in opts ? opts.bearer : KIOSK_JWT
  if (bearer) req.headers.authorization = `Bearer ${bearer}`
  if (opts.clientDevHeader) req.headers['x-device-dev'] = opts.clientDevHeader
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

/** RECORDER binding の fetch に届いた要求。 */
function forwarded(): { pathname: string, headers: Record<string, string>, body: unknown } {
  expect(recorderFetch).toHaveBeenCalledTimes(1)
  const [url, init] = recorderFetch.mock.calls[0] as [string, { headers: Record<string, string>, body: string }]
  return { pathname: new URL(url).pathname, headers: init.headers, body: JSON.parse(init.body) }
}

describe('POST /api/timecard/punch が recorder へ送る dev の区別 (Refs #387)', () => {
  it('★ introspect が dev_device: true → recorder への要求に X-Device-Dev: 1', async () => {
    introspectReturns({ active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'd1', dev_device: true })
    const res = await handler(makeEvent())

    const fwd = forwarded()
    expect(fwd.headers['X-Device-Dev']).toBe('1')
    // 他は従来どおり: 書き先は introspect の tenant / sub、body は card_id だけ
    expect(fwd.pathname).toBe('/tenants/t1/devices/d1/timecard-punch')
    expect(fwd.headers.Authorization).toBe(SECRET)
    expect(fwd.body).toEqual({ card_id: 'CARD-1' })
    expect(res).toBe(JSON.stringify({ seq: 1 }))
  })

  it('★ dev でない (欄なし / false / 文字列の "true") → ヘッダー自体が無い', async () => {
    for (const devDevice of [undefined, false, 'true', 1]) {
      recorderFetch.mockClear()
      introspectReturns({ active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'd1', dev_device: devDevice })
      await handler(makeEvent())
      expect('X-Device-Dev' in forwarded().headers).toBe(false)
    }
  })

  it('★ ブラウザが X-Device-Dev を付けてきても、introspect が dev でなければ付かない', async () => {
    await handler(makeEvent({ clientDevHeader: '1' }))
    expect('X-Device-Dev' in forwarded().headers).toBe(false)
  })

  it('利用者の browser JWT (dev の欄を持たない) は従来どおり device_id=browser でヘッダー無し', async () => {
    introspectReturns({ active: true, tenant_id: 't1', role: 'admin', sub: 'u1' })
    await handler(makeEvent({ bearer: jwt({ sub: 'u1', tenant_id: 't1', role: 'admin' }) }))
    const fwd = forwarded()
    expect(fwd.pathname).toBe('/tenants/t1/devices/browser/timecard-punch')
    expect('X-Device-Dev' in fwd.headers).toBe(false)
  })
})

describe('POST /api/timecard/punch の拒否 (従来どおり)', () => {
  it('Bearer が無ければ 401 (cookie は見ない)', async () => {
    await expect(handler(makeEvent({ bearer: undefined }))).rejects.toMatchObject({ statusCode: 401 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('binding が欠けていれば 503', async () => {
    await expect(handler(makeEvent({ env: {} }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('card_id が無ければ 400', async () => {
    body = {}
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(authWorkerFetch).not.toHaveBeenCalled()
  })

  it('introspect が 200 以外なら 503、inactive なら 401', async () => {
    introspectReturns({}, 500)
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 503 })
    introspectReturns({ active: false })
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 401 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('dev ログインの token (token_kind: dev) は dev端末とは別物で、403 のまま', async () => {
    introspectReturns({ active: true, tenant_id: 't1', role: 'admin', sub: 'u1' })
    await expect(handler(makeEvent({ bearer: DEV_LOGIN_JWT }))).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'dev_token_write_forbidden',
    })
    expect(recorderFetch).not.toHaveBeenCalled()
  })
})
