/**
 * キオスクのブラウザが、開発用の遠隔操作の命令への返事を送る (Refs ippoan/alc-app-s3#352)。
 *
 * 経路: キオスク / 運行管理者席 (端末の token を Bearer + `{id, payload}`)
 *   → 本 route: introspect → **role が `device-kiosk` か `device-tenko-manager` の token だけ**通す
 *   → cf-alc-recorder `POST /tenants/:t/kiosk-command-result` (`X-Recorder-Device-Id` = この端末)
 *   → recorder が「その命令の宛先がこの端末か」を確かめて `cmdres:<id>` に保存 (違えば 403)
 *
 * ★ どの端末の返事かは **token の `sub` だけ**で決める (vein-fleet/report.post.ts と同じ決め方。
 *   `alarm:<鍵の指紋>` は `alarm-<鍵の指紋>`)。登録簿との照合は要らない — 宛先の確認は recorder が
 *   命令を送ったときに残した宛先と突き合わせる
 */
// setResponseStatus は h3 から明示的に取る (firmware/report.post.ts と同じ理由)
import { setResponseStatus } from 'h3'
import { isFirmwareDeviceId } from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'
import { RECORDER_BASE } from '../../utils/print-relay'

/** 鍵で取った端末の token の `sub` (`alarm:<鍵の指紋 16 hex>`。vein-fleet/report.post.ts と同じ) */
const ALARM_SUB_RE = /^alarm:([0-9a-f]{16})$/

/** 返事を送ってよい端末の role (キオスクと運行管理者席) */
const KIOSK_REMOTE_ROLES: ReadonlySet<string> = new Set(['device-kiosk', 'device-tenko-manager'])

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, recorder } = await introspectCaller(event)
  if (!claims.active || !claims.tenant_id) {
    throw createError({ statusCode: 401, statusMessage: 'token が無効です' })
  }
  if (typeof claims.role !== 'string' || !KIOSK_REMOTE_ROLES.has(claims.role)) {
    throw createError({ statusCode: 403, statusMessage: '端末の token で送ってください' })
  }
  const keyFingerprint = typeof claims.sub === 'string' ? ALARM_SUB_RE.exec(claims.sub)?.[1] : undefined
  const deviceId = keyFingerprint ? `alarm-${keyFingerprint}` : claims.sub
  if (!isFirmwareDeviceId(deviceId)) {
    throw createError({ statusCode: 400, statusMessage: '端末の id がありません' })
  }
  const body = (await readBody(event).catch(() => undefined)) as Record<string, unknown> | null | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'id がありません' })
  }
  const res = await recorder.fetch(
    `${RECORDER_BASE}/tenants/${encodeURIComponent(claims.tenant_id)}/kiosk-command-result`,
    {
      method: 'POST',
      headers: { 'Authorization': sharedSecret, 'Content-Type': 'application/json', 'X-Recorder-Device-Id': deviceId },
      body: JSON.stringify({ id: body.id, payload: body.payload ?? null }),
    },
  )
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
