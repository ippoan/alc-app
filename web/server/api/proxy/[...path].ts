/**
 * REST API proxy: `/api/proxy/<path>` → rust-alc-api `/api/<path>`
 *
 * #434 step 2 consumer 横展開 (carins #38 / nuxt_dtako_logs と同型)。
 * introspect 検証 → X-Tenant-ID + X-User-ID/Email/Role 注入を
 * @ippoan/auth-client/server の createIdentityProxyHandler に集約する。
 *
 * 旧版 (kiosk-proxy 手組み + introspectToken 直叩き、device-kiosk role のみ許可) を
 * 置換する。rust-alc-api は #441 で JWT 検証を撤去し注入 identity を信頼する dumb
 * backend になったため、X-Tenant-ID だけでなく X-User-ID/Email/Role も載せないと
 * AuthUser 必須 handler が 500 になる。createIdentityProxyHandler は introspect
 * 結果から X-User-* も載せてこれを解消する。
 *
 * - browser JWT は cookie (`logi_auth_token`) / Bearer のどちらでも受ける。
 *   キオスク端末は device JWT を Bearer で送る (= 段階移行で従来 caller を壊さない)。
 * - introspect は AUTH_WORKER service binding (worker-to-worker, in-process) で
 *   叩くので外部 req を増やさない。
 * - INTERNAL_SHARED_SECRET は Secrets Store binding (.get()) のため route 側で
 *   resolve してから渡す。
 */
import type { H3Event } from 'h3'
import { createIdentityProxyHandler } from '@ippoan/auth-client/server'

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
  const config = useRuntimeConfig(event)

  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })
  }

  const authWorkerUrl =
    (config.public.authWorkerUrl as string) ||
    (typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org')
  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined

  const proxy = createIdentityProxyHandler({
    backendUrl: (e) =>
      (useRuntimeConfig(e).alcApiUrl as string) ||
      (useRuntimeConfig(e).public.apiBase as string) ||
      'https://alc-api.ippoan.org',
    authWorkerUrl,
    sharedSecret,
    // AUTH_WORKER service binding 経由で introspect (worker-to-worker, in-process)。
    introspectFetch: authWorker ? () => authWorker.fetch.bind(authWorker) : undefined,
  })
  return proxy(event)
})
