/**
 * 免許証タブ「theearth から乗務員マスタを同期」(Refs ippoan/alc-app-s3#125)。
 *
 * 経路: 管理者ブラウザ (browser JWT を Bearer、body 無し)
 *   → 本 route: token を auth-worker `/auth/introspect` (AUTH_WORKER service binding)
 *     で検証して active / tenant_id / role を得る (print/[deviceId].post.ts と同型)
 *   → role が管理者でなければ 403
 *   → dtako-scraper-relay `POST /kintai-relay/driver-master-run` (SCRAPER_RELAY
 *     service binding + X-Alc-Proxy-Secret = INTERNAL_SHARED_SECRET) に `{tenant_id}`
 *   → relay の応答 (status と JSON) をそのまま返す。
 *
 * ★ tenant_id は introspect の結果だけを使う。ブラウザからの body / query は読まない。
 * ★ INTERNAL_SHARED_SECRET はこの route の中だけ (ブラウザに返さない・ログしない)。
 *
 * 純粋ロジック (認可判定・forward 構築) は server/utils/driver-master-sync.ts。
 */
import type { H3Event } from 'h3'
import { buildIntrospectForward } from '../../utils/print-relay'
import { buildDriverMasterRunForward, decideDriverMasterAccess } from '../../utils/driver-master-sync'

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : undefined
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: '認証が必要です' })
  }

  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
  const relay = env.SCRAPER_RELAY as { fetch: typeof fetch } | undefined
  if (!sharedSecret || !authWorker || !relay) {
    throw createError({ statusCode: 503, statusMessage: 'binding が未設定です' })
  }

  // 1. 管理者の browser JWT を introspect → active / tenant_id / role
  const introspect = buildIntrospectForward({
    sharedSecret,
    token,
    origin: getRequestURL(event).origin,
  })
  const introRes = await authWorker.fetch(introspect.url, introspect.init)
  if (introRes.status !== 200) {
    throw createError({ statusCode: 503, statusMessage: 'introspect に失敗しました' })
  }
  const access = decideDriverMasterAccess(await introRes.json())
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  // 2. relay へ同期を依頼し、応答 (status + JSON) を素通しする
  const fwd = buildDriverMasterRunForward({ sharedSecret, tenantId: access.tenantId })
  const res = await relay.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
