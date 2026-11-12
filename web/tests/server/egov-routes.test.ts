// e-Gov 本番へのログインと、到達番号ごとの状況の口 (server/api/egov/*。Refs ippoan/alc-app#676)。
// トークンは HttpOnly の cookie にだけ置き、worker `egov-prod` (binding `EGOV`) へ何を送るかを固定する。値は架空。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createError, createEvent, getHeader, getRequestURL, type H3Event } from 'h3'
import {
  ACCESS_COOKIE, ARRIVE_ID, DEFAULT_RETURN, REFRESH_COOKIE, REFRESH_MAX_AGE, STATE_COOKIE,
  safeReturn, summarizeApply, takeState, withMark,
} from '../../server/utils/egov-session'

const SECRET = 'test-internal-shared-secret-32!!'
const CLIENT_ID = 'test-egov-client-id'
const ARRIVE = '20991231235959001e'

type Handler = (event: H3Event) => Promise<unknown>
let login: Handler
let callback: Handler
let apply: Handler
let logout: Handler

beforeAll(async () => {
  // introspect-route は Nuxt の自動 import (global) を使う
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestURL', getRequestURL)
  login = (await import('../../server/api/egov/login.get')).default as unknown as Handler
  callback = (await import('../../server/api/egov/callback.get')).default as unknown as Handler
  apply = (await import('../../server/api/egov/apply/[arriveId].get')).default as unknown as Handler
  logout = (await import('../../server/api/egov/logout.post')).default as unknown as Handler
})

afterAll(() => {
  vi.unstubAllGlobals()
})

let introspect: { claims: unknown }
let authWorkerFetch: ReturnType<typeof vi.fn>
/** worker `egov-prod` が受けた Request と、返す応答 (path ごと。配列なら順に返す) */
let egovCalls: Request[]
let egovReplies: Record<string, Response | Response[]>
let egovFetch: ReturnType<typeof vi.fn>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const TOKEN = { access_token: 'at-1', expires_in: 300, refresh_token: 'rt-1', refresh_expires_in: 86400 }
const DETAIL = { results: { status: '審査中', arrive_id: ARRIVE, arrive_date: '2099-12-31 00:00:00', proc_name: '架空の届出', notice_count: 2, doc_count: 1 } }

beforeEach(() => {
  introspect = { claims: { active: true, tenant_id: 't1', role: 'admin', sub: 'u1' } }
  authWorkerFetch = vi.fn(async () => json(introspect.claims))
  egovCalls = []
  egovReplies = {}
  egovFetch = vi.fn(async (req: Request) => {
    egovCalls.push(req)
    const r = egovReplies[new URL(req.url).pathname]
    if (Array.isArray(r)) return r.shift()!
    return r ?? json({ error: 'not_found' }, 404)
  })
})

interface Opts {
  method?: string
  url: string
  cookies?: Record<string, string>
  bearer?: string | null
  env?: Record<string, unknown>
  params?: Record<string, string>
}

function event(o: Opts): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = o.method ?? 'GET'
  req.url = o.url
  req.headers.host = 'alc.example.test'
  if (o.bearer !== null) req.headers.authorization = `Bearer ${o.bearer ?? 'admin-jwt'}`
  if (o.cookies) req.headers.cookie = Object.entries(o.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  const ev = createEvent(req, new ServerResponse(req))
  ev.context.cloudflare = {
    env: o.env ?? {
      INTERNAL_SHARED_SECRET: SECRET,
      AUTH_WORKER: { fetch: authWorkerFetch },
      RECORDER: { fetch: vi.fn() },
      EGOV: { fetch: egovFetch },
      EGOV_CLIENT_ID: { get: async () => CLIENT_ID },
    },
  }
  ev.context.params = o.params ?? {}
  return ev
}

/** 応答に付いた Set-Cookie (名前 → その行) */
function setCookies(ev: H3Event): Record<string, string> {
  const raw = ev.node.res.getHeader('set-cookie') as string[] | string | undefined
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  return Object.fromEntries(lines.map(l => [l.split('=')[0]!, l]))
}

const location = (ev: H3Event) => ev.node.res.getHeader('location') as string

async function bodyOf(req: Request) {
  return JSON.parse(await req.text()) as Record<string, string>
}

describe('egov-session の小物', () => {
  it('戻り先は同じ origin のパスだけ (外へ出られる形は既定へ倒す)', () => {
    expect(safeReturn('/?role=admin&tab=tenko_filing&arrive=1')).toBe('/?role=admin&tab=tenko_filing&arrive=1')
    for (const v of ['//evil.example', '/\\evil.example', 'https://evil.example/', undefined, 3]) {
      expect(safeReturn(v)).toBe(DEFAULT_RETURN)
    }
    expect(withMark('/a', 'egov=ng')).toBe('/a?egov=ng')
    expect(withMark('/a?b=1', 'egov=ng')).toBe('/a?b=1&egov=ng')
  })

  it('到達番号の形 (16〜18 桁、末尾 1 字は英小文字のことがある)', () => {
    expect(['20261112115909308e', '2099123123595902', '209912312359590012'].map(v => ARRIVE_ID.test(v))).toEqual([true, true, true])
    expect(['abc', '2099', '20991231235959001E', '../x'].map(v => ARRIVE_ID.test(v))).toEqual([false, false, false, false])
  })

  it('状況の要約: 件数が無ければ一覧の長さ、それも無ければ 0', () => {
    expect(summarizeApply({ status: 's', arrive_date: 'd', proc_name: 'p', notice_list: [1, 2], official_list: [1] }))
      .toEqual({ status: 's', arrive_date: 'd', proc_name: 'p', notice_count: 2, doc_count: 1 })
    expect(summarizeApply({ status: 's', arrive_date: 'd', proc_name: 'p' }))
      .toEqual({ status: 's', arrive_date: 'd', proc_name: 'p', notice_count: 0, doc_count: 0 })
  })

  it('預けた state は 1 回で消え、壊れていれば null', () => {
    const ok = event({ url: '/', cookies: { [STATE_COOKIE]: JSON.stringify({ state: 's', verifier: 'v', ret: '//evil' }) } })
    expect(takeState(ok)).toEqual({ state: 's', verifier: 'v', ret: DEFAULT_RETURN })
    expect(setCookies(ok)[STATE_COOKIE]).toContain('Max-Age=0')
    expect(takeState(event({ url: '/' }))).toBeNull()
    expect(takeState(event({ url: '/', cookies: { [STATE_COOKIE]: '{"state":1}' } }))).toBeNull()
  })
})

describe('GET /api/egov/login', () => {
  it('★ PKCE と state を HttpOnly の cookie に預け、本番の e-Gov の認可へ戻り先 /api/egov/callback で送る', async () => {
    const ev = event({ url: `/api/egov/login?return=${encodeURIComponent('/?role=admin&tab=tenko_filing&arrive=1')}`, bearer: null })
    await login(ev)
    expect(ev.node.res.statusCode).toBe(302)
    const to = new URL(location(ev))
    expect(`${to.origin}${to.pathname}`).toBe('https://account.e-gov.go.jp/auth/auth')
    expect(to.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(to.searchParams.get('redirect_uri')).toBe('http://alc.example.test/api/egov/callback')
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    const line = setCookies(ev)[STATE_COOKIE]!
    expect(line).toMatch(/HttpOnly/)
    expect(line).toMatch(/Secure/)
    expect(line).toMatch(/SameSite=Lax/)
    expect(line).toMatch(/Path=\/api\/egov/)
    expect(line).toMatch(/Max-Age=600/)
    const saved = JSON.parse(decodeURIComponent(line.split(';')[0]!.slice(STATE_COOKIE.length + 1)))
    expect(saved.state).toBe(to.searchParams.get('state'))
    expect(saved.ret).toBe('/?role=admin&tab=tenko_filing&arrive=1')
    expect(saved.verifier).toHaveLength(64)
  })

  it('binding かソフトウェア ID が無い環境 (staging 等) は 503', async () => {
    await expect(login(event({ url: '/api/egov/login', env: { EGOV: { fetch: egovFetch } } }))).rejects.toMatchObject({ statusCode: 503 })
    await expect(login(event({ url: '/api/egov/login', env: { EGOV_CLIENT_ID: CLIENT_ID } }))).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('GET /api/egov/callback', () => {
  const state = { [STATE_COOKIE]: JSON.stringify({ state: 'st-1', verifier: 'ver-1', ret: '/?role=admin&tab=tenko_filing' }) }

  it('★ 認可コードを worker の /token で替え、トークンは HttpOnly の cookie に置いて元の画面へ戻す', async () => {
    egovReplies['/token'] = json(TOKEN)
    const ev = event({ url: '/api/egov/callback?code=c-1&state=st-1', cookies: state, bearer: null })
    await callback(ev)
    expect(location(ev)).toBe('/?role=admin&tab=tenko_filing')
    expect(await bodyOf(egovCalls[0]!)).toEqual({
      grant_type: 'authorization_code', code: 'c-1', redirect_uri: 'http://alc.example.test/api/egov/callback', code_verifier: 'ver-1',
    })
    const c = setCookies(ev)
    expect(c[ACCESS_COOKIE]).toMatch(/^egov_at=at-1; Max-Age=270; Path=\/api\/egov; HttpOnly; Secure; SameSite=Lax/)
    // refresh token は e-Gov が長く返しても上限で切る
    expect(c[REFRESH_COOKIE]).toContain(`Max-Age=${REFRESH_MAX_AGE}`)
    expect(c[STATE_COOKIE]).toContain('Max-Age=0')
  })

  it('refresh token が無い・短い応答はそのまま', async () => {
    egovReplies['/token'] = json({ access_token: 'at-1', expires_in: 10 })
    const ev = event({ url: '/api/egov/callback?code=c-1&state=st-1', cookies: state })
    await callback(ev)
    expect(Object.keys(setCookies(ev))).toEqual([STATE_COOKIE, ACCESS_COOKIE])
    egovReplies['/token'] = json({ ...TOKEN, expires_in: 1, refresh_expires_in: 60 })
    const ev2 = event({ url: '/api/egov/callback?code=c-1&state=st-1', cookies: state })
    await callback(ev2)
    expect(setCookies(ev2)[ACCESS_COOKIE]).toContain('Max-Age=1;')
    expect(setCookies(ev2)[REFRESH_COOKIE]).toContain('Max-Age=60;')
  })

  it('state が合わない・無い・コードが無い・取り替えに失敗したら、元の画面に egov=ng を付けて戻す (トークンは置かない)', async () => {
    egovReplies['/token'] = [json({ error: 'invalid_grant' }, 400), json({ unexpected: true })]
    const cases = [
      { url: '/api/egov/callback?code=c-1&state=other', cookies: state, to: '/?role=admin&tab=tenko_filing&egov=ng' },
      { url: '/api/egov/callback?code=c-1&state=st-1', to: `${DEFAULT_RETURN}&egov=ng` },
      { url: '/api/egov/callback?state=st-1&error=access_denied', cookies: state, to: '/?role=admin&tab=tenko_filing&egov=ng' },
      { url: '/api/egov/callback?code=&state=st-1', cookies: state, to: '/?role=admin&tab=tenko_filing&egov=ng' },
      { url: '/api/egov/callback?code=c-1&state=st-1', cookies: state, to: '/?role=admin&tab=tenko_filing&egov=ng' },
      { url: '/api/egov/callback?code=c-1&state=st-1', cookies: state, to: '/?role=admin&tab=tenko_filing&egov=ng' },
    ]
    for (const c of cases) {
      const ev = event({ url: c.url, cookies: c.cookies })
      await callback(ev)
      expect(location(ev)).toBe(c.to)
      expect(setCookies(ev)[ACCESS_COOKIE]).toBeUndefined()
    }
    expect(egovCalls).toHaveLength(2)
  })
})

describe('GET /api/egov/apply/{到達番号}', () => {
  const call = (cookies: Record<string, string> = { [ACCESS_COOKIE]: 'at-1' }, arriveId = ARRIVE, bearer?: string | null) =>
    event({ url: `/api/egov/apply/${arriveId}`, params: { arriveId }, cookies, bearer })

  it('★ admin だけ。cookie のトークンで worker の /api/apply/{到達番号} を呼び、状況の要約だけ返す', async () => {
    egovReplies[`/api/apply/${ARRIVE}`] = json(DETAIL)
    const ev = call()
    expect(await apply(ev)).toEqual({ status: '審査中', arrive_date: '2099-12-31 00:00:00', proc_name: '架空の届出', notice_count: 2, doc_count: 1 })
    expect(egovCalls[0]!.headers.get('authorization')).toBe('Bearer at-1')
    expect(ev.node.res.getHeader('cache-control')).toBe('no-store')
  })

  it('alc の token が無効・admin でない・到達番号の形でないときは e-Gov を呼ばない', async () => {
    introspect.claims = { active: false }
    await expect(apply(call())).rejects.toMatchObject({ statusCode: 401 })
    introspect.claims = { active: true, tenant_id: 't1', role: 'manager' }
    await expect(apply(call())).rejects.toMatchObject({ statusCode: 403, statusMessage: 'システム管理者だけが見られます' })
    introspect.claims = { active: true, tenant_id: 't1', role: 'admin' }
    await expect(apply(call(undefined, '..%2Fx'))).rejects.toMatchObject({ statusCode: 400 })
    await expect(apply(event({ url: '/api/egov/apply/' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(apply(call(undefined, ARRIVE, null))).rejects.toMatchObject({ statusCode: 401 })
    expect(egovCalls).toHaveLength(0)
  })

  it('アクセストークンが無ければ refresh token で取り直して呼び、新しいトークンを cookie に置く', async () => {
    egovReplies['/token'] = json({ ...TOKEN, access_token: 'at-2', refresh_token: 'rt-2' })
    egovReplies[`/api/apply/${ARRIVE}`] = json(DETAIL)
    const ev = call({ [REFRESH_COOKIE]: 'rt-1' })
    await apply(ev)
    expect(await bodyOf(egovCalls[0]!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1' })
    expect(egovCalls[1]!.headers.get('authorization')).toBe('Bearer at-2')
    expect(setCookies(ev)[ACCESS_COOKIE]).toContain('egov_at=at-2')
  })

  it('e-Gov が 401 なら 1 回だけ取り直して呼び直す', async () => {
    egovReplies['/token'] = json({ ...TOKEN, access_token: 'at-2' })
    egovReplies[`/api/apply/${ARRIVE}`] = [json({}, 401), json(DETAIL)]
    expect(await apply(call({ [ACCESS_COOKIE]: 'at-old', [REFRESH_COOKIE]: 'rt-1' }))).toMatchObject({ status: '審査中' })
    expect(egovCalls.map(r => new URL(r.url).pathname)).toEqual([`/api/apply/${ARRIVE}`, '/token', `/api/apply/${ARRIVE}`])
  })

  it('ログインが要る (トークンが無い・取り直せない・取り直しても 401) は 401 egov_login_required で、cookie を消す', async () => {
    await expect(apply(call({}))).rejects.toMatchObject({ statusCode: 401, statusMessage: 'egov_login_required' })
    expect(egovCalls).toHaveLength(0)

    egovReplies['/token'] = json({ error: 'invalid_grant' }, 400)
    const ev = call({ [REFRESH_COOKIE]: 'rt-dead' })
    await expect(apply(ev)).rejects.toMatchObject({ statusMessage: 'egov_login_required' })
    expect(setCookies(ev)[REFRESH_COOKIE]).toContain('Max-Age=0')

    egovReplies[`/api/apply/${ARRIVE}`] = json({}, 401)
    await expect(apply(call({ [ACCESS_COOKIE]: 'at-old' }))).rejects.toMatchObject({ statusMessage: 'egov_login_required' })

    egovReplies['/token'] = json(TOKEN)
    egovReplies[`/api/apply/${ARRIVE}`] = [json({}, 401), json({}, 401)]
    await expect(apply(call({ [ACCESS_COOKIE]: 'at-old', [REFRESH_COOKIE]: 'rt-1' }))).rejects.toMatchObject({ statusMessage: 'egov_login_required' })

    egovReplies['/token'] = json(TOKEN)
    egovReplies[`/api/apply/${ARRIVE}`] = json({}, 401)
    await expect(apply(call({ [REFRESH_COOKIE]: 'rt-1' }))).rejects.toMatchObject({ statusMessage: 'egov_login_required' })
  })

  it('e-Gov のエラーは状態と title / detail を返す (本文が読めなければ状態だけ)', async () => {
    egovReplies[`/api/apply/${ARRIVE}`] = json({ title: '該当なし', detail: '到達番号が見つかりません' }, 404)
    await expect(apply(call())).rejects.toMatchObject({ statusCode: 404, statusMessage: 'e-Gov のエラー (404): 該当なし: 到達番号が見つかりません' })
    egovReplies[`/api/apply/${ARRIVE}`] = new Response('<html>', { status: 502 })
    await expect(apply(call())).rejects.toMatchObject({ statusCode: 502, statusMessage: 'e-Gov のエラー (502)' })
  })
})

describe('POST /api/egov/logout', () => {
  it('refresh token を e-Gov で失効させ、cookie を消す。失効に失敗しても消す', async () => {
    egovReplies['/logout'] = new Response(null, { status: 204 })
    const ev = event({ method: 'POST', url: '/api/egov/logout', cookies: { [ACCESS_COOKIE]: 'at-1', [REFRESH_COOKIE]: 'rt-1' } })
    expect(await logout(ev)).toEqual({ ok: true })
    expect(await bodyOf(egovCalls[0]!)).toEqual({ refresh_token: 'rt-1' })
    expect(setCookies(ev)[ACCESS_COOKIE]).toContain('Max-Age=0')
    expect(setCookies(ev)[REFRESH_COOKIE]).toContain('Max-Age=0')

    egovFetch.mockRejectedValueOnce(new Error('down'))
    const ev2 = event({ method: 'POST', url: '/api/egov/logout', cookies: { [REFRESH_COOKIE]: 'rt-1' } })
    expect(await logout(ev2)).toEqual({ ok: true })
    expect(setCookies(ev2)[REFRESH_COOKIE]).toContain('Max-Age=0')

    const ev3 = event({ method: 'POST', url: '/api/egov/logout' })
    await logout(ev3)
    expect(egovFetch).toHaveBeenCalledTimes(2)
  })
})
