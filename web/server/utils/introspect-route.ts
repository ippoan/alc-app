/**
 * 自前で introspect する server route の共通の前段 (Refs ippoan/alc-app#403)。
 *
 * Bearer の取り出し → binding と secret の解決 → auth-worker `/auth/introspect`。
 * 文言と順序は timecard/punch.post.ts と同じ。**役割 (role) の判定はしない** —
 * 返した claims を route ごとの `decide…Access` に渡す。
 *
 * ★ INTERNAL_SHARED_SECRET は route の中だけ (ブラウザに返さない・ログしない)。
 */
import type { H3Event } from 'h3'
import type { IntrospectClaims } from './print-relay'
import { buildIntrospectForward } from './print-relay'

export interface IntrospectedCaller {
  token: string
  claims: IntrospectClaims
  sharedSecret: string
  authWorker: { fetch: typeof fetch }
  recorder: { fetch: typeof fetch }
}

async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

export async function introspectCaller(event: H3Event): Promise<IntrospectedCaller> {
  const token = /^Bearer\s+(.+)$/i.exec(getHeader(event, 'authorization') ?? '')?.[1]
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: '認証が必要です' })
  }

  const env = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
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
  const claims = ((await introRes.json()) as IntrospectClaims | null) ?? {}
  return { token, claims, sharedSecret, authWorker, recorder }
}
