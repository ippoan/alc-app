// `/api/firmware/{report,devices,update}` の route が、誰を通し、auth-worker と recorder へ
// **実際に何を送るか**を固定する (Refs ippoan/alc-app#403)。
//
// - report  … キオスクの端末の token だけ + 登録簿との照合 (fail-closed)
// - devices … admin だけ (dev ログインの token は読める)
// - update  … admin だけ + dev ログインの token は 403 + device_id 必須 + target は定数
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
let devices: Handler
let update: Handler

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
  report = (await import('../../server/api/firmware/report.post')).default as unknown as Handler
  devices = (await import('../../server/api/firmware/devices.get')).default as unknown as Handler
  update = (await import('../../server/api/firmware/update.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  body = undefined
  readBodyFails = false
  introspect = { claims: KIOSK_CLAIMS, status: 200 }
  labels = { json: { devices: [{ device_id: 'd1', label: '事務所' }, { device_id: 'd2', label: null }] }, status: 200 }
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
const reportEvent = (opts?: Opts) => makeEvent('POST', '/api/firmware/report', opts)
const devicesEvent = (opts?: Opts) => makeEvent('GET', '/api/firmware/devices', { bearer: ADMIN_JWT, ...opts })
const updateEvent = (opts?: Opts) => makeEvent('POST', '/api/firmware/update', { bearer: ADMIN_JWT, ...opts })

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

describe('3 本に共通の前段 (introspectCaller)', () => {
  const routes: Array<[string, () => Handler, (opts?: Opts) => H3Event]> = [
    ['report', () => report, reportEvent],
    ['devices', () => devices, devicesEvent],
    ['update', () => update, updateEvent],
  ]

  for (const [name, handler, event] of routes) {
    it(`${name}: Bearer が無ければ 401 (cookie は見ない)`, async () => {
      await expect(handler()(event({ bearer: undefined, headers: { cookie: `logi_auth_token=${ADMIN_JWT}` } }))).rejects.toMatchObject({
        statusCode: 401,
        statusMessage: '認証が必要です',
      })
      expect(authWorkerFetch).not.toHaveBeenCalled()
      expect(recorderFetch).not.toHaveBeenCalled()
    })

    it(`${name}: binding・secret のどれかが欠けていれば 503`, async () => {
      const full = { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: recorderFetch } }
      for (const missing of ['INTERNAL_SHARED_SECRET', 'AUTH_WORKER', 'RECORDER'] as const) {
        const env: Record<string, unknown> = { ...full }
        delete env[missing]
        await expect(handler()(event({ env }))).rejects.toMatchObject({
          statusCode: 503,
          statusMessage: 'binding が未設定です',
        })
      }
      expect(authWorkerFetch).not.toHaveBeenCalled()
    })

    it(`${name}: introspect が 200 以外なら 503、inactive なら 401`, async () => {
      introspect = { claims: {}, status: 500 }
      await expect(handler()(event())).rejects.toMatchObject({
        statusCode: 503,
        statusMessage: 'introspect に失敗しました',
      })
      introspect = { claims: { active: false }, status: 200 }
      await expect(handler()(event())).rejects.toMatchObject({ statusCode: 401, statusMessage: 'token が無効です' })
      // introspect の本文が null でも落ちずに 401
      introspect = { claims: null, status: 200 }
      await expect(handler()(event())).rejects.toMatchObject({ statusCode: 401 })
      expect(recorderFetch).not.toHaveBeenCalled()
    })
  }

  it('introspect へは secret の生の値・token・origin を送る', async () => {
    body = { device_id: 'd1', kind: 'cores3', phase: 'idle' }
    await report(reportEvent())
    const [url, init] = authWorkerFetch.mock.calls[0] as [string, { method: string, headers: Record<string, string>, body: string }]
    expect(url).toBe('https://auth-worker.internal/auth/introspect')
    expect(init.headers.Authorization).toBe(SECRET)
    expect(JSON.parse(init.body)).toEqual({ token: KIOSK_JWT, origin: 'http://alc.example.test' })
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store の binding ({get}) でも解決する。get が空なら 503', async () => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] })))
    const env = (secret: unknown) => ({
      INTERNAL_SHARED_SECRET: secret,
      AUTH_WORKER: { fetch: authWorkerFetch },
      RECORDER: { fetch: recorderFetch },
    })
    await devices(devicesEvent({ env: env({ get: async () => SECRET }) }))
    expect(forwarded().headers.Authorization).toBe(SECRET)

    await expect(devices(devicesEvent({ env: env({ get: async () => null }) }))).rejects.toMatchObject({ statusCode: 503 })
    await expect(devices(devicesEvent({ env: env({ get: 'x' }) }))).rejects.toMatchObject({ statusCode: 503 })
    await expect(devices(devicesEvent({ env: env(0) }))).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('POST /api/firmware/report', () => {
  const REPORT = { device_id: 'd1', kind: 'cores3', phase: 'writing', pct: 40, version: '1.2.3' }

  beforeEach(() => {
    body = { ...REPORT }
  })

  it('★ キオスクの token + 登録簿に在る端末 → recorder へ報告をそのまま渡し、応答を素通し', async () => {
    const event = reportEvent()
    const res = await report(event)

    const fwd = forwarded()
    expect(fwd.method).toBe('POST')
    expect(fwd.pathname).toBe('/tenants/t1/ota-report')
    expect(fwd.headers).toEqual({ Authorization: SECRET, 'Content-Type': 'application/json' })
    expect(fwd.body).toBe(JSON.stringify(REPORT))
    expect(res).toBe(JSON.stringify({ ok: true }))
    expect(getResponseStatus(event)).toBe(200)
    expectNoStore(event)

    // 登録簿は introspect の tenant で、secret の生の値で引く
    const [[url, init]] = labelsCalls() as [[string, RequestInit]]
    expect(url).toBe('https://auth-worker.internal/internal/device-labels?tenant_id=t1')
    expect(init).toEqual({ method: 'GET', headers: { Authorization: SECRET } })
  })

  it('★ 利用者の token (admin / member / viewer) とほかの端末は 403 で、登録簿も recorder も呼ばない', async () => {
    for (const role of ['admin', 'member', 'viewer', 'device-hub', 'device-print', 'device-timecard', undefined]) {
      introspect = { claims: { active: true, tenant_id: 't1', role, sub: 'u1' }, status: 200 }
      await expect(report(reportEvent({ bearer: ADMIN_JWT }))).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'この端末からは報告できません',
      })
    }
    expect(labelsCalls()).toHaveLength(0)
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('開発用の端末 (dev_device) の token は、ふつうの端末と同じに通る', async () => {
    introspect = { claims: { ...KIOSK_CLAIMS, dev_device: true }, status: 200 }
    await report(reportEvent())
    expect(forwarded().pathname).toBe('/tenants/t1/ota-report')
  })

  it('body が object でない (無し・null・配列・文字列・読めない) → 400', async () => {
    for (const b of [undefined, null, ['d1'], 'd1', 1]) {
      body = b
      await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'body がありません' })
    }
    readBodyFails = true
    await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'body がありません' })
    expect(labelsCalls()).toHaveLength(0)
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('device_id が欠ける・形が違う → 400', async () => {
    for (const deviceId of [undefined, null, 1, '', 'a'.repeat(65), 'a/b']) {
      body = { ...REPORT, device_id: deviceId }
      await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'device_id がありません' })
    }
    expect(labelsCalls()).toHaveLength(0)
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('kind が cores3 以外 → 400', async () => {
    for (const kind of [undefined, 'timecard-station', 'CoreS3', 1]) {
      body = { ...REPORT, kind }
      await expect(report(reportEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'kind が不正です' })
    }
    expect(labelsCalls()).toHaveLength(0)
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('★ 登録簿に無い device_id は 400 で recorder を呼ばない', async () => {
    body = { ...REPORT, device_id: 'unknown-device' }
    await expect(report(reportEvent())).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: '登録されていない端末です',
    })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('label が null の端末も登録簿に在るので通る', async () => {
    body = { ...REPORT, device_id: 'd2' }
    await report(reportEvent())
    expect(JSON.parse(forwarded().body!)).toMatchObject({ device_id: 'd2' })
  })

  it('★ 登録簿が 503・401・形違い・例外のどれでも 503 で recorder を呼ばない (fail-closed)', async () => {
    const failures: Array<typeof labels> = [
      { json: { error: 'server_error' }, status: 503 },
      { json: { error: 'unauthorized' }, status: 401 },
      { json: { devices: 'd1' }, status: 200 },
      { json: null, status: 200 },
      () => new Response('not json'),
      () => { throw new Error('network') },
    ]
    for (const f of failures) {
      labels = f
      await expect(report(reportEvent())).rejects.toMatchObject({
        statusCode: 503,
        statusMessage: '端末の一覧を取得できません',
      })
    }
    expect(labelsCalls()).toHaveLength(failures.length)
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('★ tenant は introspect の値だけ。body やヘッダーに混ぜても URL は変わらない', async () => {
    body = { ...REPORT, tenant_id: 'other-tenant' }
    await report(reportEvent({ headers: { 'x-tenant-id': 'other-tenant' } }))
    expect(forwarded().pathname).toBe('/tenants/t1/ota-report')
    expect(labelsCalls()[0]![0]).toContain('tenant_id=t1')
  })

  it('recorder の 400 (phase が不正など) は status と本文がそのまま返る', async () => {
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_phase' }), { status: 400 }))
    body = { ...REPORT, phase: 'bogus' }
    const event = reportEvent()
    const res = await report(event)
    expect(res).toBe(JSON.stringify({ error: 'invalid_phase' }))
    expect(getResponseStatus(event)).toBe(400)
    expectNoStore(event)
  })
})

describe('GET /api/firmware/devices', () => {
  const STATUS = {
    devices: [
      { device_id: 'd1', kind: 'cores3', phase: 'idle', version: '1.2.3', reported_at_ms: 2 },
      { device_id: 'gone', kind: 'cores3', phase: 'failed', reason: 'x', reported_at_ms: 1 },
    ],
  }

  beforeEach(() => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch = vi.fn(async () => new Response(JSON.stringify(STATUS), { status: 200 }))
  })

  it('★ admin → recorder の一覧に label を足して返す (登録簿に無い端末は null)', async () => {
    const event = devicesEvent()
    const res = await devices(event)

    const fwd = forwarded()
    expect(fwd.method).toBe('GET')
    expect(fwd.pathname).toBe('/tenants/t1/ota-status')
    expect(fwd.headers).toEqual({ Authorization: SECRET })
    expect(fwd.body).toBeUndefined()
    expect(res).toEqual({
      devices: [
        { ...STATUS.devices[0], label: '事務所' },
        { ...STATUS.devices[1], label: null },
      ],
    })
    expectNoStore(event)
  })

  it('★ admin 以外 (member / viewer / キオスクの端末) は 403 で recorder を呼ばない', async () => {
    for (const role of ['member', 'viewer', 'device-kiosk', undefined]) {
      introspect = { claims: { active: true, tenant_id: 't1', role, sub: 'u1' }, status: 200 }
      await expect(devices(devicesEvent())).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'ファームの更新は管理者のみ実行できます',
      })
    }
    expect(recorderFetch).not.toHaveBeenCalled()
    expect(labelsCalls()).toHaveLength(0)
  })

  it('★ dev ログインの token (role admin) は通る (読み取りだけ)', async () => {
    const res = (await devices(devicesEvent({ bearer: DEV_LOGIN_JWT }))) as { devices: unknown[] }
    expect(res.devices).toHaveLength(2)
  })

  it('★ ラベルの取得が失敗 (非 200・形違い・例外) しても 200 で label が null', async () => {
    const failures: Array<typeof labels> = [
      { json: { error: 'server_error' }, status: 503 },
      { json: {}, status: 200 },
      () => { throw new Error('network') },
    ]
    for (const f of failures) {
      labels = f
      const event = devicesEvent()
      const res = (await devices(event)) as { devices: Array<{ label: unknown }> }
      expect(res.devices.map(d => d.label)).toEqual([null, null])
      expect(getResponseStatus(event)).toBe(200)
    }
  })

  it('0 件は {devices: []}', async () => {
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] })))
    expect(await devices(devicesEvent())).toEqual({ devices: [] })
  })

  it('recorder が非 200 なら、その status と本文を素通しし、登録簿は引かない', async () => {
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }))
    const event = devicesEvent()
    const res = await devices(event)
    expect(res).toBe(JSON.stringify({ error: 'server_error' }))
    expect(getResponseStatus(event)).toBe(503)
    expectNoStore(event)
    expect(labelsCalls()).toHaveLength(0)
  })
})

describe('POST /api/firmware/update', () => {
  beforeEach(() => {
    introspect = { claims: ADMIN_CLAIMS, status: 200 }
    recorderFetch = vi.fn(async () => new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
    body = { device_id: 'd1' }
  })

  it('★ admin + device_id → recorder へ行く body は {"target":"cores3","device_id":"…"} と完全一致', async () => {
    // body に target や url や tenant を混ぜても無視される
    body = { device_id: 'd1', target: 'timecard-station', url: 'https://example.test/fw.bin', version: '9', tenant_id: 'other' }
    const event = updateEvent()
    const res = await update(event)

    const fwd = forwarded()
    expect(fwd.method).toBe('POST')
    expect(fwd.pathname).toBe('/tenants/t1/serial-ota')
    expect(fwd.headers).toEqual({ Authorization: SECRET, 'Content-Type': 'application/json' })
    expect(fwd.body).toBe('{"target":"cores3","device_id":"d1"}')
    expect(res).toBe(JSON.stringify({ sent: 1 }))
    expect(getResponseStatus(event)).toBe(200)
    expectNoStore(event)
    // 登録簿も状態も見ない
    expect(labelsCalls()).toHaveLength(0)
  })

  it('★ admin 以外 (member / viewer / キオスクの端末) は 403 で recorder を呼ばない', async () => {
    for (const role of ['member', 'viewer', 'device-kiosk', undefined]) {
      introspect = { claims: { active: true, tenant_id: 't1', role, sub: 'u1' }, status: 200 }
      await expect(update(updateEvent())).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'ファームの更新は管理者のみ実行できます',
      })
    }
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('★ dev ログインの token は (role が admin でも) 403 で recorder を呼ばない', async () => {
    await expect(update(updateEvent({ bearer: DEV_LOGIN_JWT }))).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'dev_token_write_forbidden',
    })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('★ device_id が欠ける・形が違う (null・数値・65 文字・記号) は 400 で recorder を呼ばない', async () => {
    for (const b of [undefined, null, 'd1', {}, { device_id: null }, { device_id: 1 }, { device_id: '' }, { device_id: 'a'.repeat(65) }, { device_id: 'a b' }, { device_id: 'a;b' }]) {
      body = b
      await expect(update(updateEvent())).rejects.toMatchObject({ statusCode: 400, statusMessage: 'device_id がありません' })
    }
    readBodyFails = true
    await expect(update(updateEvent())).rejects.toMatchObject({ statusCode: 400 })
    expect(recorderFetch).not.toHaveBeenCalled()
  })

  it('recorder の応答 (sent: 0 / 400) は status と本文がそのまま返る', async () => {
    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))
    expect(await update(updateEvent())).toBe(JSON.stringify({ sent: 0 }))

    recorderFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_device_id' }), { status: 400 }))
    const event = updateEvent()
    expect(await update(event)).toBe(JSON.stringify({ error: 'invalid_device_id' }))
    expect(getResponseStatus(event)).toBe(400)
  })
})
