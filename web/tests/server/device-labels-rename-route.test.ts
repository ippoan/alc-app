// `/api/device-labels/rename` (管理者が端末の名前を変える。Refs ippoan/alc-app-s3#352) が、誰を通し、
// auth-worker へ **実際に何を送るか**を固定する。
//
// - admin だけ・dev ログインの token は 403 (読み取りの /api/device-labels とは分ける)
// - `alarm-<指紋>` / `alarm:<指紋>` → 鍵のラベル: JWT を cookie に載せて /device/setup/alarm-key/rename
// - それ以外 → 登録簿のラベル: shared secret + introspect の tenant で /internal/device-labels/rename
// - label は trim して 1〜64 字 (だめなら auth-worker を呼ばずに 400)
// - auth-worker の 404 → 404、409 → 409 + error 素通し、それ以外 → 502
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  createError, createEvent, defineEventHandler, getHeader, getRequestURL, getResponseHeader,
  getResponseStatus, setResponseHeader, type H3Event,
} from 'h3'
import { buildAlarmKeyRenameForward } from '../../server/utils/cam-host-keys'
import { buildDeviceLabelRenameForward, normalizeDeviceLabel, renameTargetOf } from '../../server/utils/firmware-relay'

const SECRET = 'test-internal-shared-secret-32!!'
const FP = '0123456789abcdef'

/** 署名はダミー (route は署名を見ない。検証は introspect = auth-worker)。 */
function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`
}
const ADMIN_JWT = jwt({ sub: 'u1', tenant_id: 't1', role: 'admin' })
const DEV_LOGIN_JWT = jwt({ sub: 'u1', tenant_id: 't1', role: 'admin', token_kind: 'dev' })
const ADMIN_CLAIMS = { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' }

type Handler = (event: H3Event) => Promise<unknown>
let route: Handler
let authWorkerFetch: ReturnType<typeof vi.fn>
let introspect: { claims: unknown, status: number }
/** rename の口の応答。関数なら例外も出せる */
let renamed: (() => Response) | { body: string, status: number }
let body: unknown

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  vi.stubGlobal('readBody', async () => body)
  route = (await import('../../server/api/device-labels/rename.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  introspect = { claims: ADMIN_CLAIMS, status: 200 }
  body = { device_id: `alarm-${FP}`, label: '事務所の指静脈' }
  renamed = { status: 200, body: JSON.stringify({ ok: true, fingerprint: FP, label: '事務所の指静脈' }) }
  authWorkerFetch = vi.fn(async (url: string) => {
    if (new URL(url).pathname === '/auth/introspect') {
      return new Response(JSON.stringify(introspect.claims), { status: introspect.status })
    }
    if (typeof renamed === 'function') return renamed()
    return new Response(renamed.body, { status: renamed.status })
  })
})

function event(bearer: string = ADMIN_JWT): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = '/api/device-labels/rename'
  req.headers.host = 'alc.example.test'
  req.headers.authorization = `Bearer ${bearer}`
  const ev = createEvent(req, new ServerResponse(req))
  ev.context.cloudflare = {
    env: { INTERNAL_SHARED_SECRET: SECRET, AUTH_WORKER: { fetch: authWorkerFetch }, RECORDER: { fetch: vi.fn() } },
  }
  return ev
}

/** introspect 以外に auth-worker へ届いた要求 */
function renameCalls(): Array<[string, { method: string, headers: Record<string, string>, body: string }]> {
  return (authWorkerFetch.mock.calls as Array<[string, { method: string, headers: Record<string, string>, body: string }]>)
    .filter(([url]) => new URL(url).pathname !== '/auth/introspect')
}

describe('POST /api/device-labels/rename', () => {
  it('★ alarm-<指紋> → 鍵のラベル: 同じ JWT を cookie に載せ、{fingerprint, label} だけを送る (shared secret は載せない)', async () => {
    const ev = event()
    expect(await route(ev)).toEqual({ ok: true, device_id: `alarm-${FP}`, label: '事務所の指静脈' })
    const calls = renameCalls()
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]!
    expect(new URL(url).pathname).toBe('/device/setup/alarm-key/rename')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Cookie: `logi_auth_token=${ADMIN_JWT}`, 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ fingerprint: FP, label: '事務所の指静脈' })
    expect(getResponseHeader(ev, 'Cache-Control')).toBe('no-store')
  })

  it('alarm:<指紋> (token の sub の形) も鍵の rename に行く', async () => {
    body = { device_id: `alarm:${FP}`, label: 'x' }
    await route(event())
    expect(new URL(renameCalls()[0]![0]).pathname).toBe('/device/setup/alarm-key/rename')
  })

  it('★ それ以外 → 登録簿のラベル: shared secret の生の値 + introspect の tenant で {tenant_id, device_id, label}', async () => {
    body = { device_id: 'cores3-aaaa', label: '  ロビー  ', tenant_id: 'evil' }
    renamed = { status: 200, body: JSON.stringify({ ok: true, device_id: 'cores3-aaaa', label: 'ロビー' }) }
    expect(await route(event())).toEqual({ ok: true, device_id: 'cores3-aaaa', label: 'ロビー' })
    const [url, init] = renameCalls()[0]!
    expect(new URL(url).pathname).toBe('/internal/device-labels/rename')
    expect(init.headers).toEqual({ Authorization: SECRET, 'Content-Type': 'application/json' })
    // tenant は body から受けない
    expect(JSON.parse(init.body)).toEqual({ tenant_id: 't1', device_id: 'cores3-aaaa', label: 'ロビー' })
  })

  it('200 の本文に label が無ければ送った label を返す', async () => {
    body = { device_id: 'cores3-aaaa', label: 'ロビー' }
    renamed = { status: 200, body: 'not json' }
    expect(await route(event())).toEqual({ ok: true, device_id: 'cores3-aaaa', label: 'ロビー' })
  })

  it('★ 無効な token は 401、admin でなければ 403 (auth-worker の rename は呼ばない)', async () => {
    introspect = { claims: { active: false }, status: 200 }
    await expect(route(event())).rejects.toMatchObject({ statusCode: 401 })
    introspect = { claims: { ...ADMIN_CLAIMS, role: 'viewer' }, status: 200 }
    await expect(route(event())).rejects.toMatchObject({ statusCode: 403, statusMessage: '名前の変更は管理者のみ実行できます' })
    expect(renameCalls()).toHaveLength(0)
  })

  it('★ dev ログインの token (role admin) は 403 で rename を呼ばない', async () => {
    await expect(route(event(DEV_LOGIN_JWT))).rejects.toMatchObject({ statusCode: 403, statusMessage: 'dev_token_write_forbidden' })
    expect(renameCalls()).toHaveLength(0)
  })

  it.each([
    ['body が無い', undefined],
    ['device_id が無い', { label: 'x' }],
    ['device_id の形が違う', { device_id: 'a b', label: 'x' }],
    ['alarm- だが指紋の形でない', { device_id: 'alarm-XYZ', label: 'x' }],
    ['label が無い', { device_id: 'cores3-aaaa' }],
    ['label が空白だけ', { device_id: 'cores3-aaaa', label: '   ' }],
    ['label が 65 字', { device_id: 'cores3-aaaa', label: 'あ'.repeat(65) }],
    ['label が文字列でない', { device_id: 'cores3-aaaa', label: 3 }],
  ])('★ %s → 400 で auth-worker の rename を呼ばない', async (_name, b) => {
    body = b
    await expect(route(event())).rejects.toMatchObject({ statusCode: 400 })
    expect(renameCalls()).toHaveLength(0)
  })

  it.each(['revoked', 'duplicate_label'])('★ auth-worker の 409 {error:%s} は 409 と error をそのまま返す', async (error) => {
    renamed = { status: 409, body: JSON.stringify({ error }) }
    const ev = event()
    expect(await route(ev)).toEqual({ error })
    expect(getResponseStatus(ev)).toBe(409)
  })

  it('409 の error が知らない値・本文が読めないなら error は conflict', async () => {
    renamed = { status: 409, body: JSON.stringify({ error: 'secret detail' }) }
    expect(await route(event())).toEqual({ error: 'conflict' })
    renamed = { status: 409, body: 'x' }
    expect(await route(event())).toEqual({ error: 'conflict' })
  })

  it('auth-worker の 404 は 404', async () => {
    renamed = { status: 404, body: '{"error":"not_found"}' }
    await expect(route(event())).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each([
    ['400', () => new Response('{"error":"bad"}', { status: 400 })],
    ['403', () => new Response('forbidden', { status: 403 })],
    ['500', () => new Response('boom', { status: 500 })],
    ['例外', () => { throw new Error('network') }],
  ] as Array<[string, () => Response]>)('★ auth-worker の %s は 502 (詳細を返さない)', async (_name, res) => {
    renamed = res
    await expect(route(event())).rejects.toMatchObject({ statusCode: 502, statusMessage: '名前を変えられませんでした' })
  })
})

describe('rename の純関数', () => {
  it('鍵の forward は cookie と JSON だけ', () => {
    expect(buildAlarmKeyRenameForward('t', { fingerprint: FP, label: 'x' })).toEqual({
      url: 'https://auth-worker.internal/device/setup/alarm-key/rename',
      init: { method: 'POST', headers: { Cookie: 'logi_auth_token=t', 'Content-Type': 'application/json' }, body: `{"fingerprint":"${FP}","label":"x"}` },
    })
  })
  it('登録簿の forward は shared secret の生の値', () => {
    expect(buildDeviceLabelRenameForward({ sharedSecret: 's', tenantId: 't/1', deviceId: 'd', label: 'x' })).toEqual({
      url: 'https://auth-worker.internal/internal/device-labels/rename',
      init: { method: 'POST', headers: { Authorization: 's', 'Content-Type': 'application/json' }, body: '{"tenant_id":"t/1","device_id":"d","label":"x"}' },
    })
  })
  it('label は trim して 1〜64 字 (UTF-16 の長さ = 入力欄の maxlength と同じ数え方)', () => {
    expect(normalizeDeviceLabel(' a ')).toBe('a')
    expect(normalizeDeviceLabel('a'.repeat(64))).toBe('a'.repeat(64))
    expect(normalizeDeviceLabel('🚚'.repeat(33))).toBeNull()
    expect(normalizeDeviceLabel('a'.repeat(65))).toBeNull()
    expect(normalizeDeviceLabel('')).toBeNull()
    expect(normalizeDeviceLabel(null)).toBeNull()
  })
  it('device_id の振り分け', () => {
    expect(renameTargetOf(`alarm-${FP}`)).toEqual({ kind: 'key', fingerprint: FP })
    expect(renameTargetOf(`alarm:${FP}`)).toEqual({ kind: 'key', fingerprint: FP })
    expect(renameTargetOf(`alarm-${FP.toUpperCase()}`)).toBeNull()
    expect(renameTargetOf('alarm:')).toBeNull()
    expect(renameTargetOf('d1')).toEqual({ kind: 'registry', deviceId: 'd1' })
    expect(renameTargetOf('a:b')).toBeNull()
    expect(renameTargetOf(1)).toBeNull()
  })
})
