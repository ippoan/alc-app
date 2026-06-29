/**
 * device JWT / browser JWT を伴う経路を auth-worker `/alc-proxy/*` に service binding で
 * thin-forward する helper + claim 時の device credential provisioning
 * (Refs ippoan/rust-alc-api#434 caller #5、Phase C 案B)。
 *
 * public-ingest (internal-proxy.ts) と違い、こちらは **JWT を持つ経路**:
 *   - device 系 (#4 settings / #5 report-version / #6 report-watchdog / #7 register-fcm-token):
 *     AlcoholChecker が `/device/token` で取得した **device JWT** を Authorization: Bearer で送る。
 *   - admin 系 (#8 trigger-update): 管理画面の browser JWT を Authorization: Bearer で送る。
 *
 * auth-worker `/alc-proxy` が JWT introspect → X-Tenant-ID/X-User-* 注入 → OIDC mint して
 * rust に forward する。alc-app は consumer proof (X-Alc-Proxy-Secret) + 元 origin
 * (X-Alc-Proxy-Origin) を載せて service binding (AUTH_WORKER) に丸投げするだけ。
 *
 * **migration fallback**: Authorization が無い (= device JWT 未対応の旧 Android) リクエストは
 * 従来どおり rust を直叩きする。lockdown (allUsers 削除) 前は直叩きも通るので非破壊。
 */
import type { H3Event } from 'h3'

const ALC_PROXY_PREFIX = '/alc-proxy'
const ALC_PROXY_BASE = 'https://alc-proxy.internal'

export interface AlcProxyForward {
  url: string
  init: RequestInit
}

/**
 * auth-worker `/alc-proxy<rustPath>` への forward request を構築する (pure、テスト対象)。
 * JWT (device / browser) を Bearer に載せ、consumer proof secret と origin を付ける。
 */
export function buildAlcProxyForward(input: {
  sharedSecret: string
  origin: string
  rustPath: string
  method: string
  token: string
  search?: string
  contentType?: string | null
  body?: BodyInit | null
}): AlcProxyForward {
  const headers: Record<string, string> = {
    'X-Alc-Proxy-Secret': input.sharedSecret,
    'X-Alc-Proxy-Origin': input.origin,
    Authorization: `Bearer ${input.token}`,
  }
  if (input.contentType) headers['Content-Type'] = input.contentType
  const url = `${ALC_PROXY_BASE}${ALC_PROXY_PREFIX}${input.rustPath}${input.search ?? ''}`
  const init: RequestInit = { method: input.method, headers }
  if (input.body != null) init.body = input.body
  return { url, init }
}

/** CF binding 群を取り出す。 */
function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/** Authorization ヘッダーから Bearer token を取り出す (無ければ undefined)。 */
function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : undefined
}

/** backend レスポンスを event に転送する。 */
async function streamJsonResponse(event: H3Event, res: Response): Promise<unknown> {
  setResponseStatus(event, res.status)
  const ct = res.headers.get('content-type')
  if (ct) setHeader(event, 'content-type', ct)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * JWT 経路を `/alc-proxy` 経由で forward する Nitro server route handler を生成する。
 * `rustPath` は固定文字列 or event から解決する関数 (settings の deviceId 埋め込み用)。
 *
 * Authorization Bearer があれば `/alc-proxy` 経由 (device/browser JWT)、無ければ
 * rust 直叩き (migration fallback、lockdown 前のみ有効)。
 */
export function createDeviceProxyHandler(rustPathInput: string | ((event: H3Event) => string)) {
  return defineEventHandler(async (event) => {
    const rustPath = typeof rustPathInput === 'function' ? rustPathInput(event) : rustPathInput
    const method = event.method

    let body: string | undefined
    let bodyContentType: string | undefined
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const parsed = await readBody(event).catch(() => undefined)
      if (parsed) {
        body = JSON.stringify(parsed)
        bodyContentType = 'application/json'
      }
    }

    const token = bearerToken(getHeader(event, 'authorization'))

    // ── Bearer あり: /alc-proxy 経由 (device JWT / browser JWT) ──
    if (token) {
      const env = cfEnv(event)
      const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
      const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
      if (sharedSecret && authWorker) {
        const { url, init } = buildAlcProxyForward({
          sharedSecret,
          origin: getRequestURL(event).origin,
          rustPath,
          method,
          token,
          contentType: bodyContentType,
          body,
        })
        return streamJsonResponse(event, await authWorker.fetch(url, init))
      }
      // binding 未設定は fallback に落とす (開発環境等)。
    }

    // ── Bearer なし or binding 未設定: rust 直叩き (migration fallback) ──
    // native fetch を使う ($fetch は typed-routes 推論で動的 path に型エラーを出すため)。
    const config = useRuntimeConfig()
    const target = `${config.public.apiBase as string}${rustPath}`
    const res = await fetch(target, {
      method,
      ...(body ? { body, headers: { 'Content-Type': 'application/json' } } : {}),
    })
    return streamJsonResponse(event, res)
  })
}
