// `/api/kiosk-remote/result` (開発用の遠隔操作の返事) の route が、誰を通し、recorder へ
// **実際に何を送るか**を固定する (Refs ippoan/alc-app-s3#352)。
//
// - キオスクの端末の token だけ (role `device-kiosk`)
// - 返す端末は token の sub だけで決め、`X-Recorder-Device-Id` に載せる (`alarm:<fp>` は `alarm-<fp>`)
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

function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}

const KIOSK_JWT = jwt({ sub: 'k1', tenant_id: 't1', role: 'device-kiosk', aud: 'device' })
const KIOSK_CLAIMS = { active: true, tenant_id: 't1', role: 'device-kiosk', sub: 'k1' }

type Handler = (event: H3Event) => Promise<unknown>
let result: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let recorderFetch: ReturnType<typeof vi.fn>
let body: unknown
let readBodyFails: boolean
let introspect: { claims: unknown, status: number }

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  vi.stubGlobal('readBody', async () => {
    if (readBodyFails) throw new Error('invalid json')
    return body
  })
  result = (await import('../../server/api/kiosk-remote/result.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  body = { id: 'cmd-1', payload: { done: true, ok: true } }
  readBodyFails = false
  introspect = { claims: KIOSK_CLAIMS, status: 200 }
  authWorkerFetch = vi.fn(async () => new Response(JSON.stringify(introspect.claims), { status: introspect.status }))
  recorderFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
})

function makeEvent(): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = '/api/kiosk-remote/result'
  req.headers.host = 'alc.example.test'
  req.headers.authorization = `Bearer ${KIOSK_JWT}`
  const event = createEvent(req, new ServerResponse(req))
  event.context.cloudflare = {
    env: { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: recorderFetch } },
  }
  return event
}

describe('POST /api/kiosk-remote/result', () => {
  it('★ キオスクの返事を、token の端末として recorder へ渡す', async () => {
    const event = makeEvent()
    expect(await result(event)).toBe(JSON.stringify({ ok: true }))
    expect(getResponseStatus(event)).toBe(200)
    expect(getResponseHeader(event, 'Cache-Control')).toBe('no-store')
    expect(recorderFetch).toHaveBeenCalledTimes(1)
    const [url, init] = recorderFetch.mock.calls[0] as [string, { method: string, headers: Record<string, string>, body: string }]
    expect(new URL(url).pathname).toBe('/tenants/t1/kiosk-command-result')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Authorization': SECRET, 'X-Recorder-Device-Id': 'k1' })
    expect(JSON.parse(init.body)).toEqual({ id: 'cmd-1', payload: { done: true, ok: true } })
  })

  it('鍵で取った端末の token は alarm-<指紋> で返す。payload が無ければ null', async () => {
    introspect = { claims: { ...KIOSK_CLAIMS, sub: 'alarm:0123456789abcdef' }, status: 200 }
    body = { id: 'cmd-2' }
    await result(makeEvent())
    const [, init] = recorderFetch.mock.calls[0] as [string, { headers: Record<string, string>, body: string }]
    expect(init.headers['X-Recorder-Device-Id']).toBe('alarm-0123456789abcdef')
    expect(JSON.parse(init.body)).toEqual({ id: 'cmd-2', payload: null })
  })

  it('recorder の 403 (宛先と違う端末) はそのまま返す', async () => {
    recorderFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'wrong_device' }), { status: 403 }))
    const event = makeEvent()
    expect(await result(event)).toBe(JSON.stringify({ error: 'wrong_device' }))
    expect(getResponseStatus(event)).toBe(403)
  })

  it('キオスク以外の token は通さない', async () => {
    introspect = { claims: { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' }, status: 200 }
    await expect(result(makeEvent())).rejects.toMatchObject({ statusCode: 403 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('端末の id が無い・body が外れていれば 400', async () => {
    introspect = { claims: { ...KIOSK_CLAIMS, sub: '' }, status: 200 }
    await expect(result(makeEvent())).rejects.toMatchObject({ statusCode: 400 })
    introspect = { claims: KIOSK_CLAIMS, status: 200 }
    for (const b of [null, [], { payload: {} }]) {
      body = b
      await expect(result(makeEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'id がありません' })
    }
    readBodyFails = true
    await expect(result(makeEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })
})
