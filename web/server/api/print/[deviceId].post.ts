/**
 * operator 印刷 (Refs ippoan/alc-app-s3#38) — PDF を対象 AtomS3 印刷ブリッジへ
 * WS push する server route。
 *
 * 経路: operator ブラウザ (browser JWT + `{pdfBase64}`)
 *   → 本 route: token を auth-worker `/auth/introspect` で検証して tenant_id を得る
 *   → base64 を 4 文字境界で分割し `print_begin`/`print_data`/`print_end` を
 *     cf-alc-recorder `POST /tenants/:t/devices/:d/command` へ **逐次** push
 *     (RECORDER service binding + INTERNAL_SHARED_SECRET)
 *   → 接続中の AtomS3 が受信し LAN の 9100 プリンターへ印字 (firmware は #57)。
 *
 * 純粋ロジック (分割・コマンド組立・forward 構築) は server/utils/print-relay.ts。
 */
import type { H3Event } from 'h3'
import {
  buildIntrospectForward,
  buildPrintCommands,
  buildRecorderCommandForward,
  splitBase64,
} from '../../utils/print-relay'

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
  const deviceId = getRouterParam(event, 'deviceId')
  if (!deviceId) {
    throw createError({ statusCode: 400, statusMessage: 'deviceId が必要です' })
  }
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

  const body = (await readBody(event).catch(() => undefined)) as { pdfBase64?: unknown } | undefined
  const pdfBase64 = typeof body?.pdfBase64 === 'string' ? body.pdfBase64 : ''
  if (!pdfBase64) {
    throw createError({ statusCode: 400, statusMessage: 'pdfBase64 がありません' })
  }

  // 1. operator の browser JWT を introspect → tenant_id (自テナントの device
  //    にしか送れない — recorder が /tenants/:t の DO へ routing する)
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
  const tenantId = claims.tenant_id

  // 2. base64 を分割 → print_begin / print_data* / print_end を逐次 push (順序保持)
  const chunks = splitBase64(pdfBase64)
  const commands = buildPrintCommands(chunks)
  let sent = 0
  for (const payload of commands) {
    const fwd = buildRecorderCommandForward({ sharedSecret, tenantId, deviceId, payload })
    const res = await recorder.fetch(fwd.url, fwd.init)
    if (res.status !== 202) {
      // 202 以外 (404=device_not_connected 等) は以降を中断して返す
      return {
        ok: false,
        error: res.status === 404 ? 'device_not_connected' : 'recorder_error',
        failedAction: payload.action,
        sent,
      }
    }
    sent += 1
  }
  return { ok: true, chunks: chunks.length, commands: sent }
})
