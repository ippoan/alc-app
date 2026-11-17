// `/api/health` (右下の版表示の読み先) が、画面の版と auth-worker の版だけを返し、
// auth-worker が引けないときも 200 で画面を壊さないことを固定する (Refs ippoan/alc-app-s3#352)。
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent, defineEventHandler, getResponseHeader, setResponseHeader, type H3Event } from 'h3'

// 画面の `appVersion` と同じ出どころ (runtimeConfig.public.appVersion)。テスト環境では 'dev'
let APP_VERSION: string

type Handler = (event: H3Event) => Promise<unknown>
let route: Handler

beforeAll(async () => {
  APP_VERSION = String(useRuntimeConfig().public.appVersion)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  route = (await import('../../server/api/health.get')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.useRealTimers()
})

function event(env: Record<string, unknown> | undefined): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/api/health'
  req.headers.host = 'alc.example.test'
  const ev = createEvent(req, new ServerResponse(req))
  if (env) ev.context.cloudflare = { env }
  return ev
}

function authWorker(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return { fetch: vi.fn(impl) }
}

describe('GET /api/health', () => {
  it('★ auth-worker が版を返す → 画面の版と auth-worker の版を両方返す (no-store)', async () => {
    const aw = authWorker(async () => new Response(JSON.stringify({ status: 'ok', auth_worker_version: 'v0.2.417' })))
    const ev = event({ AUTH_WORKER: aw })
    expect(await route(ev)).toEqual({ status: 'ok', version: APP_VERSION, auth_worker_version: 'v0.2.417' })
    const [url, init] = aw.fetch.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/health')
    expect(init).toEqual({ method: 'GET' })
    expect(getResponseHeader(ev, 'Cache-Control')).toBe('no-store')
  })

  it('auth-worker が 200 以外 → auth_worker_version を省く', async () => {
    const aw = authWorker(async () => new Response('down', { status: 503 }))
    expect(await route(event({ AUTH_WORKER: aw }))).toEqual({ status: 'ok', version: APP_VERSION })
  })

  it('auth-worker の fetch が投げる → auth_worker_version を省いて 200', async () => {
    const aw = authWorker(async () => { throw new Error('network') })
    expect(await route(event({ AUTH_WORKER: aw }))).toEqual({ status: 'ok', version: APP_VERSION })
  })

  it('応答に版が無い・空・文字列でない・JSON が null → 省く', async () => {
    for (const body of ['{"status":"ok"}', '{"auth_worker_version":""}', '{"auth_worker_version":1}', 'null']) {
      const aw = authWorker(async () => new Response(body))
      expect(await route(event({ AUTH_WORKER: aw }))).toEqual({ status: 'ok', version: APP_VERSION })
    }
  })

  it('2 秒で返らない → 待たずに省いて返す', async () => {
    vi.useFakeTimers()
    const aw = authWorker(() => new Promise<Response>(() => {}))
    const pending = route(event({ AUTH_WORKER: aw }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ status: 'ok', version: APP_VERSION })
  })

  it('binding が無い (env 無し・AUTH_WORKER 無し) → auth-worker を引かずに画面の版だけ', async () => {
    expect(await route(event(undefined))).toEqual({ status: 'ok', version: APP_VERSION })
    expect(await route(event({}))).toEqual({ status: 'ok', version: APP_VERSION })
  })
})
