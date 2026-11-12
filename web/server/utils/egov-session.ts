/**
 * 点呼の届出の「申請済みの控え」の行に e-Gov での状況を出すための、e-Gov 本番へのログインと呼び出し
 * (Refs ippoan/alc-app#676)。
 *
 * - 部品は egov-check (ippoan/nuxt-egov) と共通: 認可 URL と PKCE は SDK `@ippoan/egov-shinsei-sdk`、
 *   トークンの取得と API の呼び出しは worker `egov-prod` (service binding `EGOV`。client_secret は worker が足す)
 * - ソフトウェア ID は egov-check の本番と同じもの (Secrets Store `NUXT_PUBLIC_EGOV_CLIENT_ID_PROD`)。
 *   戻り先 `https://alc.ippoan.org/api/egov/callback` はそのソフトウェア ID に登録して使う
 * - ★ トークンは HttpOnly の cookie (path `/api/egov`) にだけ置く。画面の JS には渡さない。
 *   refresh token も最長 {@link REFRESH_MAX_AGE} 秒で消す (長く残さない)
 * - e-Gov のトークンは e-Gov の利用者のもの (テナントではない)。テナントの境目は控えの口
 *   (`/api/tenko/filing-archives`) の側にあり、ここでは見ない
 */
import type { H3Event } from 'h3'
import { createError, deleteCookie, getCookie, getRequestURL, setCookie } from 'h3'
import { resolveSecret } from './introspect-route'

/** e-Gov 本番の認証の入口 (公開情報) */
export const EGOV_AUTH_BASE = 'https://account.e-gov.go.jp/auth'
export const COOKIE_PATH = '/api/egov'
export const STATE_COOKIE = 'egov_oauth'
export const ACCESS_COOKIE = 'egov_at'
export const REFRESH_COOKIE = 'egov_rt'
/** ログインの往復 (state と code_verifier) を待つ秒数 */
export const STATE_MAX_AGE = 600
/** refresh token を残す上限の秒数 (e-Gov がもっと長く返しても、ここで切る) */
export const REFRESH_MAX_AGE = 8 * 60 * 60
/** ログインの後に戻る既定の画面 */
export const DEFAULT_RETURN = '/?role=admin&tab=tenko_filing'
/** e-Gov の到達番号の形 (alc-tenko-worker の控えの口と同じ) */
export const ARRIVE_ID = /^\d{15,17}[0-9a-z]$/

interface Fetcher { fetch: (input: Request) => Promise<Response> }
export interface EgovEnv { worker: Fetcher, clientId: string }

export interface EgovToken {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_expires_in?: number
}

export interface SavedState { state: string, verifier: string, ret: string }

/** worker の binding とソフトウェア ID。どちらか無い環境 (staging 等) では 503 */
export async function egovEnv(event: H3Event): Promise<EgovEnv> {
  const env = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
  const worker = env.EGOV as Fetcher | undefined
  const clientId = await resolveSecret(env.EGOV_CLIENT_ID)
  if (!worker || !clientId) {
    throw createError({ statusCode: 503, statusMessage: 'e-Gov の接続が未設定です' })
  }
  return { worker, clientId }
}

/** ログインの後に戻る先。同じ origin のパスだけ通す (`//host` や `/\host` は外へ出られるので既定に倒す) */
export function safeReturn(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : DEFAULT_RETURN
}

/** 戻り先に印 (`egov=ng` 等) を足す */
export function withMark(ret: string, mark: string): string {
  return `${ret}${ret.includes('?') ? '&' : '?'}${mark}`
}

export function callbackUrl(event: H3Event): string {
  return `${getRequestURL(event).origin}${COOKIE_PATH}/callback`
}

function cookieOpts(maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: COOKIE_PATH, maxAge }
}

export function saveState(event: H3Event, s: SavedState): void {
  setCookie(event, STATE_COOKIE, JSON.stringify(s), cookieOpts(STATE_MAX_AGE))
}

/** ログインの往復で預けた state を取り出して消す。無い・壊れていれば null */
export function takeState(event: H3Event): SavedState | null {
  const raw = getCookie(event, STATE_COOKIE)
  deleteCookie(event, STATE_COOKIE, { path: COOKIE_PATH })
  try {
    const s = JSON.parse(raw ?? '') as Partial<SavedState>
    return typeof s.state === 'string' && typeof s.verifier === 'string' ? { state: s.state, verifier: s.verifier, ret: safeReturn(s.ret) } : null
  }
  catch {
    return null
  }
}

export function saveTokens(event: H3Event, t: EgovToken): void {
  setCookie(event, ACCESS_COOKIE, t.access_token, cookieOpts(Math.max(t.expires_in - 30, 1)))
  if (t.refresh_token) {
    setCookie(event, REFRESH_COOKIE, t.refresh_token, cookieOpts(Math.min(t.refresh_expires_in ?? REFRESH_MAX_AGE, REFRESH_MAX_AGE)))
  }
}

export function clearTokens(event: H3Event): void {
  deleteCookie(event, ACCESS_COOKIE, { path: COOKIE_PATH })
  deleteCookie(event, REFRESH_COOKIE, { path: COOKIE_PATH })
}

/** worker の `/token` (client_secret は worker が足す)。失敗なら null */
export async function requestToken(worker: Fetcher, body: Record<string, string>): Promise<EgovToken | null> {
  const res = await worker.fetch(new Request('https://egov-worker/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  if (!res.ok) return null
  const t = await res.json() as Partial<EgovToken>
  return typeof t.access_token === 'string' && typeof t.expires_in === 'number' ? t as EgovToken : null
}

/** refresh token で取り直す。取れなければ cookie を消して null */
async function refresh(event: H3Event, worker: Fetcher): Promise<string | null> {
  const rt = getCookie(event, REFRESH_COOKIE)
  const t = rt ? await requestToken(worker, { grant_type: 'refresh_token', refresh_token: rt }) : null
  if (!t) {
    clearTokens(event)
    return null
  }
  saveTokens(event, t)
  return t.access_token
}

/** 画面はこの文字で「e-Gov へのログインが要る」と見分ける */
export const LOGIN_REQUIRED = 'egov_login_required'

function loginRequired() {
  return createError({ statusCode: 401, statusMessage: LOGIN_REQUIRED })
}

/**
 * e-Gov API v2 を GET で呼ぶ (worker の `/api/**` 経由)。アクセストークンが切れていれば 1 回だけ取り直す。
 * ログインが要るときは 401 `egov_login_required`、e-Gov のエラーはその状態と title / detail を返す。
 */
export async function egovGet<T>(event: H3Event, worker: Fetcher, path: string): Promise<T> {
  let refreshed = false
  let at = getCookie(event, ACCESS_COOKIE) ?? null
  if (!at) {
    at = await refresh(event, worker)
    refreshed = true
  }
  if (!at) throw loginRequired()
  const send = (token: string) => worker.fetch(new Request(`https://egov-worker/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
  let res = await send(at)
  if (res.status === 401 && !refreshed) {
    at = await refresh(event, worker)
    if (!at) throw loginRequired()
    res = await send(at)
  }
  if (res.status === 401) throw loginRequired()
  const body = await res.json().catch(() => null) as { title?: string, detail?: string } | null
  if (!res.ok) {
    const detail = [body?.title, body?.detail].filter(Boolean).join(': ')
    throw createError({ statusCode: res.status, statusMessage: `e-Gov のエラー (${res.status})${detail ? `: ${detail}` : ''}` })
  }
  return body as T
}

/** 申請済みの控えの行に出す、到達番号ごとの e-Gov での状況 */
export interface EgovApplySummary {
  status: string
  arrive_date: string
  proc_name: string
  notice_count: number
  doc_count: number
}

interface ApplyDetail {
  status: string
  arrive_date: string
  proc_name: string
  notice_count?: number
  doc_count?: number
  notice_list?: unknown[]
  official_list?: unknown[]
}

export function summarizeApply(r: ApplyDetail): EgovApplySummary {
  return {
    status: r.status,
    arrive_date: r.arrive_date,
    proc_name: r.proc_name,
    notice_count: r.notice_count ?? r.notice_list?.length ?? 0,
    doc_count: r.doc_count ?? r.official_list?.length ?? 0,
  }
}
