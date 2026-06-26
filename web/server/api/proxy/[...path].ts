/**
 * REST API proxy: `/api/proxy/<path>` → auth-worker `/alc-proxy/*` → rust-alc-api `/api/<path>`
 *
 * #434 step 3 (方式 B): introspect / ACL / OIDC mint / identity 注入を
 * auth-worker `/alc-proxy/*` に集約し、consumer は createAuthWorkerProxyHandler で
 * service binding (AUTH_WORKER) に thin-forward するだけ。旧 createIdentityProxyHandler
 * (方式 A) を置換。consumer は X-Alc-Proxy-Secret (=INTERNAL_SHARED_SECRET、consumer
 * proof) + X-Alc-Proxy-Origin + browser JWT のみ。auth-worker (#308) が
 * X-Alc-Proxy-Secret を constant-time 検証してから JWT 検証 + ACL + OIDC mint +
 * X-Tenant-ID/X-User-* 注入を行う。
 *
 * - browser JWT は cookie (logi_auth_token) / Bearer のどちらでも受ける。キオスク端末は
 *   device JWT を Bearer で送る (方式 B でも Authorization は素通しされ維持される)。
 * - AUTH_WORKER service binding は方式 B では必須 (未設定は 503)。
 * - INTERNAL_SHARED_SECRET は Secrets Store binding (.get()) のため route 側で resolve。
 */
import type { H3Event } from 'h3'
import { createAuthWorkerProxyHandler } from '@ippoan/auth-client/server'

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

export default defineEventHandler(async (event) => {
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

  const proxy = createAuthWorkerProxyHandler({
    sharedSecret,
    authWorkerFetch: () => authWorker.fetch.bind(authWorker),
  })
  return proxy(event)
})
