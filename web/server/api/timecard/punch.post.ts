/**
 * ブラウザ (キオスク / 管理画面) の打刻 (Refs ippoan/alc-app-s3#134)。
 *
 * 経路: ブラウザ (browser JWT or キオスク device JWT を Bearer + `{card_id}`)
 *   → 本 route: token を auth-worker `/auth/introspect` (AUTH_WORKER service
 *     binding) で検証して tenant_id / device_id を決める
 *     (print/[deviceId].post.ts と同型)
 *   → cf-alc-recorder `POST /tenants/:t/devices/:d/timecard-punch`
 *     (RECORDER service binding + INTERNAL_SHARED_SECRET)
 *   → recorder の DO が ingest 転送 (rust-alc-api `POST /api/hub/measurements`) の
 *     あとに `/watch-timecard` の購読者へ合図を出す。
 *     dev端末の token (introspect の `dev_device === true`) なら `X-Device-Dev: 1` を
 *     付け、recorder が dev の行・dev の購読者へ振る (Refs ippoan/alc-app#387)。
 *
 * **rust-alc-api の `POST /api/timecard/punch` を直に叩かせない。** 直行すると
 * その打刻だけ合図が鳴らない (経路依存の挙動になる)。
 *
 * ★ tenant_id / device_id は introspect の結果だけを使う。body は `card_id` のみ。
 * ★ INTERNAL_SHARED_SECRET はこの route の中だけ (ブラウザに返さない・ログしない)。
 *
 * 純粋ロジック (認可判定・forward 構築) は server/utils/timecard-relay.ts。
 */
import type { H3Event } from 'h3'
import { buildIntrospectForward, isDevLoginToken } from '../../utils/print-relay'
import { buildRecorderTimecardPunchForward, decideTimecardPunchAccess } from '../../utils/timecard-relay'

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

  const body = (await readBody(event).catch(() => undefined)) as { card_id?: unknown } | undefined
  const cardId = typeof body?.card_id === 'string' ? body.card_id : ''
  if (!cardId) {
    throw createError({ statusCode: 400, statusMessage: 'card_id がありません' })
  }

  // 1. browser / kiosk JWT を introspect → tenant_id / device_id
  const introspect = buildIntrospectForward({
    sharedSecret,
    token,
    origin: getRequestURL(event).origin,
  })
  const introRes = await authWorker.fetch(introspect.url, introspect.init)
  if (introRes.status !== 200) {
    throw createError({ statusCode: 503, statusMessage: 'introspect に失敗しました' })
  }
  // dev端末 (開発用の鍵) の token か (Refs ippoan/alc-app#387)。**決めるのは introspect の
  // `dev_device === true` だけ** — ブラウザの申告 (body / ヘッダー) は読まない。
  // 下の `isDevLoginToken` (dev ログインの拒否) とは別物。
  const isDevDevice = ((await introRes.clone().json()) as { dev_device?: unknown } | null)?.dev_device === true
  const access = decideTimecardPunchAccess(await introRes.json())
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  // dev-login (`token_kind: "dev"`) は本番に書かせない (Refs ippoan/alc-app#162)。
  // **auth-worker の read-only enforcement (#433) は `/alc-proxy` の中にあり、
  // 自前 introspect のこの route には効かない。** 「post-merge の検証セッションは
  // 本番を変更しない」は検証を気軽に回すための土台なので、副作用のある route 側で
  // 明示的に塞ぐ。判定するのは introspect が active を返した後 = 署名検証済み。
  if (isDevLoginToken(token)) {
    throw createError({ statusCode: 403, statusMessage: 'dev_token_write_forbidden' })
  }

  // 2. recorder へ渡す (kind / seq は recorder 側が立てる)。応答は素通し —
  //    ブラウザは 2xx なら打刻一覧を引き直すだけで、中身は見ない
  const fwd = buildRecorderTimecardPunchForward({
    sharedSecret,
    tenantId: access.tenantId,
    deviceId: access.deviceId,
    cardId,
  })
  // dev端末の打刻は recorder に `X-Device-Dev: 1` で伝える。recorder はこれを backend への
  // 転送と `/watch-timecard` の合図の両方に使う。**dev でなければヘッダー自体を付けない**
  const headers = { ...(fwd.init.headers as Record<string, string>) }
  if (isDevDevice) headers['X-Device-Dev'] = '1'
  const res = await recorder.fetch(fwd.url, { ...fwd.init, headers })
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
