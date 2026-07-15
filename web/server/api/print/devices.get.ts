/**
 * operator 印刷 (Refs ippoan/alc-app-s3#38) — 自テナントの接続中デバイス一覧。
 *
 * operator の browser JWT を auth-worker `/auth/introspect` で検証して tenant_id を
 * 得て、cf-alc-recorder `GET /tenants/:t/devices` (接続中の device_id 一覧) を
 * 返す。印刷先の選択肢に使う (未接続デバイスには push できないため接続中のみ)。
 */
import type { H3Event } from 'h3'
import { buildIntrospectForward, buildRecorderDevicesForward } from '../../utils/print-relay'

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
  const recorder = env.RECORDER as { fetch: typeof fetch } | undefined
  if (!sharedSecret || !authWorker || !recorder) {
    throw createError({ statusCode: 503, statusMessage: 'binding が未設定です' })
  }

  const introspect = buildIntrospectForward({
    sharedSecret,
    token,
    origin: getRequestURL(event).origin,
  })
  const introRes = await authWorker.fetch(introspect.url, introspect.init)
  if (introRes.status !== 200) {
    throw createError({ statusCode: 503, statusMessage: 'introspect に失敗しました' })
  }
  const claims = (await introRes.json()) as { active?: boolean; tenant_id?: string }
  if (!claims.active || !claims.tenant_id) {
    throw createError({ statusCode: 401, statusMessage: 'token が無効です' })
  }

  const fwd = buildRecorderDevicesForward({ sharedSecret, tenantId: claims.tenant_id })
  const res = await recorder.fetch(fwd.url, fwd.init)
  if (res.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: 'recorder への接続に失敗しました' })
  }
  return (await res.json()) as { devices: string[] }
})
