/**
 * API テスト共通環境
 *
 * API_BASE_URL が設定されていれば実 API (live)、未設定なら mock fetch。
 * api.test.ts から使い、同じ CRUD テストを両モードで実行可能にする。
 */
import { vi, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { initApi } from '~/utils/api'
import {
  TEST_TENANT_ID, TEST_USER_ID, JWT_SECRET,
} from './api-test-data'

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------
export const isLive = !!process.env.API_BASE_URL
const API_BASE = process.env.API_BASE_URL || 'https://api.example.com'

// ---------------------------------------------------------------------------
// Mock helpers (no-op in live mode)
// ---------------------------------------------------------------------------
export const mockFetch = vi.fn()

export function okJson(data: unknown = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

export function ok204() {
  return { ok: true, status: 204 }
}

export function errResponse(status: number, body = '') {
  return { ok: false, status, statusText: 'Error', text: () => Promise.resolve(body) }
}

/**
 * mock モード: mockFetch にレスポンスをセット
 * live モード: 何もしない (実 fetch が走る)
 */
export function stubResponse(response: unknown) {
  if (!isLive) mockFetch.mockResolvedValueOnce(response)
}

export function stubOk(data: unknown = {}) {
  stubResponse(okJson(data))
}

export function stub204() {
  stubResponse(ok204())
}

export function stubReject(error: Error) {
  if (!isLive) mockFetch.mockRejectedValueOnce(error)
}

/**
 * mock 専用アサーション。live 時は何もしない。
 */
export function assertMock(fn: () => void) {
  if (!isLive) fn()
}

/**
 * API 呼び出し + レスポンス検証 (mock / live 両対応)
 * mock: stubOk/stub204 → fn() → result 検証
 * live: fn() → 実レスポンス検証
 */
export async function verifyApi(
  fn: () => Promise<unknown>,
  mockResponse: unknown = {},
  opts: { expect204?: boolean } = {},
) {
  if (opts.expect204) stub204()
  else stubOk(mockResponse)
  const result = await fn()
  if (opts.expect204) {
    expect(result).toBeUndefined()
  }
  return result
}

/**
 * API 呼び出しを実行。live 時は API エラー (4xx/5xx) を許容する。
 * ネットワークエラー (fetch failed) だけ fail にする。
 * it.each の URL/method 検証テスト用。
 */
export async function callApi(fn: () => Promise<unknown>) {
  if (!isLive) {
    await fn()
    return
  }
  try {
    await fn()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // API エラー = エンドポイントに到達した (URL は正しい)
    if (msg.startsWith('API エラー') || msg.startsWith('CSV ') || msg.startsWith('Upload') || msg.startsWith('アップロード')) return
    throw e // ネットワークエラーは fail
  }
}

/**
 * live 時に mockFetch.mock.calls のアサーションをスキップするためのヘルパー。
 * expect(mockFetch) が live で失敗しないよう、live 時は noop expect を返す。
 */
export function expectMock(target: unknown) {
  if (isLive) {
    // live 時: 全アサーションが no-op になるプロキシ
    const noop = new Proxy({}, { get: () => () => noop })
    return noop as ReturnType<typeof expect>
  }
  return expect(target)
}

// ---------------------------------------------------------------------------
// JWT helper (live mode 用)
// ---------------------------------------------------------------------------
function makeJwt(): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: TEST_USER_ID,
    email: 'test@example.com',
    name: 'Test Admin',
    tenant_id: TEST_TENANT_ID,
    role: 'admin',
    iat: now,
    exp: now + 3600,
  }
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  const unsigned = `${b64(header)}.${b64(payload)}`
  const sig = createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url')
  return `${unsigned}.${sig}`
}

// ---------------------------------------------------------------------------
// Wait for API (live mode 用)
// ---------------------------------------------------------------------------
async function waitForApi(url: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`API not ready after ${maxRetries} retries`)
}

// ---------------------------------------------------------------------------
// Setup / Teardown (beforeEach / afterEach から呼ぶ)
// ---------------------------------------------------------------------------
export const jwtToken = isLive ? makeJwt() : null
let liveReady = false

/**
 * live 時: rust-alc-api は #441 で dumb backend 化し、`require_tenant_header` が
 * `X-Tenant-ID` + `X-User-ID/Email/Role` を要求する (本番は server proxy =
 * `createIdentityProxyHandler` が introspect 検証して注入する)。integration テストは
 * proxy を介さず backend を直叩きするため、ここで proxy の代わりに検証済み相当の
 * identity ヘッダをテスト用 claim (= makeJwt と同値、seed.sql の admin) から注入する
 * (Refs rust-alc-api#434)。`createAuthFetch` は JWT がある時 `Bearer` のみ送り
 * X-Tenant-ID を付けない設計なので、これが無いと全 authed endpoint が 401 になる。
 *
 * globalThis.fetch を冪等にラップする (二重ラップは Symbol guard で防ぐ)。
 */
const LIVE_IDENTITY_FETCH = Symbol.for('alc-app:live-identity-fetch')
function installLiveIdentityFetch() {
  if (!isLive) return
  const current = globalThis.fetch as typeof fetch & { [LIVE_IDENTITY_FETCH]?: true }
  if (current[LIVE_IDENTITY_FETCH]) return
  const base = current
  const wrapped = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    headers.set('X-Tenant-ID', TEST_TENANT_ID)
    headers.set('X-User-ID', TEST_USER_ID)
    headers.set('X-User-Email', 'test@example.com')
    headers.set('X-User-Role', 'admin')
    if (input instanceof Request) {
      return base(new Request(input, { headers }))
    }
    return base(input, { ...init, headers })
  }) as typeof fetch & { [LIVE_IDENTITY_FETCH]?: true }
  wrapped[LIVE_IDENTITY_FETCH] = true
  globalThis.fetch = wrapped
}

/**
 * live 時: happy-dom の FormData/Blob を Node.js native に戻す。
 * happy-dom は setupFiles より先に環境を適用するため、save-native では間に合わない。
 * undici + node:buffer から直接取得する。
 */
export function restoreNativeApis() {
  if (!isLive) return
  // Blob を先にセット (undici が globalThis.Blob を参照するため)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.Blob = require('node:buffer').Blob
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.URL = require('node:url').URL
  // undici の FormData/fetch は Blob セット後にロード
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undici = require('undici')
  globalThis.FormData = undici.FormData
  globalThis.fetch = undici.fetch
  // undici fetch に差し替えた後も identity 注入ラッパーを被せ直す
  // (FormData テストは setupApi より先に restoreNativeApis だけ呼ぶため必須)。
  installLiveIdentityFetch()
}

export async function setupApi() {
  if (isLive) {
    if (!liveReady) {
      await waitForApi(API_BASE)
      liveReady = true
    }
    initApi(API_BASE, () => jwtToken!)
    installLiveIdentityFetch()
  } else {
    vi.stubGlobal('fetch', mockFetch)
    initApi(API_BASE, undefined, () => 'test-tenant')
    mockFetch.mockReset()
  }
}

export function teardownApi() {
  if (!isLive) {
    vi.unstubAllGlobals()
  }
}

export { API_BASE }
