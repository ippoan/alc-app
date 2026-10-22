/**
 * キオスクのブラウザが、自分の指静脈の対応表 (モジュールの ID ↔ 乗務員) を報告する
 * (Refs ippoan/alc-app#436)。
 *
 * 経路: キオスク (端末の token を Bearer + `{entries, module_users?, module_max?}`)
 *   → 本 route: introspect → **role が `device-kiosk` の token だけ**通す
 *   → auth-worker の登録簿と照合 (token の端末がこのテナントの未失効の端末か)
 *   → cf-alc-recorder `POST /tenants/:t/vein-list-report` (DO storage に保存)
 *
 * ★ どの端末の表かは **token の `sub` だけ**で決める。body の `device_id` は読まず、上書きする
 *   (ほかの端末の表を書き換えさせない)。
 * ★ 登録簿との照合は **fail-closed** — 取れなければ保存せず 503。載っていない端末は 400。
 * ★ 鍵で取った端末の token (Vein Station など。CoreS3 の代わりに端末になる) は `sub` が
 *   `alarm:<鍵の指紋>` で、登録簿 (devices) には行が無い。署名で本人確認済みなので照合せず、
 *   `alarm-<鍵の指紋>` を端末の id にする (recorder の id の字種に `:` が無いため)。
 * ★ 対応表の中身の検査は recorder が持つ。recorder の 400 がそのまま返る。
 */
// setResponseStatus は h3 から明示的に取る (firmware/report.post.ts と同じ理由)
import { setResponseStatus } from 'h3'
import { decideFirmwareReportAccess, isFirmwareDeviceId, loadDeviceLabels } from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'
import { buildVeinListForward } from '../../utils/vein-fleet-relay'

/** 鍵で取った端末の token の `sub` (`alarm:<鍵の指紋 16 hex>`、auth-worker の device-alarm-token) */
const ALARM_SUB_RE = /^alarm:([0-9a-f]{16})$/

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker, recorder } = await introspectCaller(event)
  const access = decideFirmwareReportAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }
  const keyFingerprint = typeof claims.sub === 'string' ? ALARM_SUB_RE.exec(claims.sub)?.[1] : undefined
  const deviceId = keyFingerprint ? `alarm-${keyFingerprint}` : claims.sub
  if (!isFirmwareDeviceId(deviceId)) {
    throw createError({ statusCode: 400, statusMessage: '端末の id がありません' })
  }

  const body = (await readBody(event).catch(() => undefined)) as Record<string, unknown> | null | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, statusMessage: 'body がありません' })
  }

  if (!keyFingerprint) {
    const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
    if (!labels) {
      throw createError({ statusCode: 503, statusMessage: '端末の一覧を取得できません' })
    }
    if (!labels.has(deviceId)) {
      throw createError({ statusCode: 400, statusMessage: '登録されていない端末です' })
    }
  }

  const fwd = buildVeinListForward({
    sharedSecret,
    tenantId: access.tenantId,
    leaf: 'report',
    report: { ...body, device_id: deviceId },
  })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
