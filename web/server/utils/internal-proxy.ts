/**
 * public ingest 経路 (browser JWT も device JWT も持たない) を auth-worker
 * `/alc-internal-proxy/*` に service binding で thin-forward する helper
 * (Refs ippoan/rust-alc-api#434 caller #5、Phase B)。
 *
 * lockdown (`allUsers` 削除 = Cloud Run IAM) 後、TenkoCall の端末登録/点呼や
 * AlcoholChecker の pairing 前端末登録は rust を直叩きできなくなる。これらは
 * 認証情報を一切持たない public_router 経路 (tenant は body/registration_code から
 * RLS / lookup で解決) なので `/alc-proxy` (browser JWT 必須) には乗らない。
 *
 * 代わりに alc-app Worker が **INTERNAL_SHARED_SECRET (consumer proof) を保持**し、
 * `X-Alc-Proxy-Secret` を付けて auth-worker `/alc-internal-proxy` に丸投げする。
 * OIDC mint (Cloud Run IAM 通過) は auth-worker 側で行う。auth-worker は
 * public-ingest クラスとして **X-Tenant-ID を一切 forward しない** (auth-worker#323)
 * ため、shared secret だけで tenant を詐称することはできない (#434 再現防止)。
 *
 * Android 端末には secret を焼かない (alc-app Worker だけが保持する)。
 */
import type { H3Event } from 'h3'

/** auth-worker 側の route prefix。 */
const INTERNAL_PROXY_PREFIX = '/alc-internal-proxy'
/**
 * service binding fetch は host を無視するが、path が `/alc-internal-proxy/...` で
 * 始まる必要がある (auth-worker 側が prefix を slice して rust に転送するため)。
 */
const INTERNAL_PROXY_BASE = 'https://alc-internal-proxy.internal'

export interface InternalProxyForward {
  url: string
  init: RequestInit
}

/**
 * auth-worker `/alc-internal-proxy<rustPath>` への forward request を構築する
 * (pure、ユニットテスト対象)。consumer proof secret だけを載せ、X-Tenant-ID 等の
 * identity ヘッダーは載せない (public-ingest クラスのため auth-worker 側でも strip)。
 */
export function buildInternalProxyForward(input: {
  sharedSecret: string
  /** rust 側 path。例: '/api/tenko-call/register' */
  rustPath: string
  method: string
  /** 例: '?x=1' / '' */
  search?: string
  contentType?: string | null
  body?: BodyInit | null
}): InternalProxyForward {
  const headers: Record<string, string> = {
    'X-Alc-Proxy-Secret': input.sharedSecret,
  }
  if (input.contentType) headers['Content-Type'] = input.contentType
  const url = `${INTERNAL_PROXY_BASE}${INTERNAL_PROXY_PREFIX}${input.rustPath}${input.search ?? ''}`
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

/**
 * 固定 rustPath の public ingest 経路を `/alc-internal-proxy` 経由で forward する
 * Nitro server route handler を生成する。
 */
export function createInternalIngestHandler(rustPath: string) {
  return defineEventHandler(async (event) => {
    const env = cfEnv(event)
    const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
    if (!sharedSecret) {
      throw createError({
        statusCode: 503,
        statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
      })
    }
    const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
    if (!authWorker) {
      throw createError({
        statusCode: 503,
        statusMessage: 'AUTH_WORKER service binding が未設定です',
      })
    }

    const method = event.method
    let body: string | undefined
    let contentType: string | undefined
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const parsed = await readBody(event).catch(() => undefined)
      if (parsed) {
        body = JSON.stringify(parsed)
        contentType = 'application/json'
      }
    }

    const { url, init } = buildInternalProxyForward({
      sharedSecret,
      rustPath,
      method,
      contentType,
      body,
    })

    const res = await authWorker.fetch(url, init)
    setResponseStatus(event, res.status)
    const ct = res.headers.get('content-type')
    if (ct) setHeader(event, 'content-type', ct)
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })
}
