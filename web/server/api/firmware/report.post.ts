/**
 * キオスクのブラウザが、繋がっている機体 (CoreS3 / 指静脈端末) の版・更新の状態を報告する
 * (Refs ippoan/alc-app#403, ippoan/alc-app-s3#352)。
 *
 * 経路: キオスク (端末の token を Bearer + 報告の object)
 *   → 本 route: introspect → **role が `device-kiosk` の token だけ**通す
 *   → `kind` で端末の id の決め方が分かれる:
 *     - `cores3` … body の `device_id` (機体の `AUTH STATUS`) を auth-worker の登録簿と照合
 *       (このテナントの未失効の端末か)
 *     - `timecard` (指静脈端末) … **body の `device_id` は読まず、端末の token の `sub` から決めて
 *       上書きする** (`deviceIdFromTokenSub`。vein-fleet の報告と同じ id)。token 由来であることが
 *       照合の代わりなので登録簿は引かない (鍵で取った token の端末は登録簿に行が無い)
 *   → cf-alc-recorder `POST /tenants/:t/ota-report` (DO storage に保存)
 *
 * ★ tenant_id は introspect の結果だけを使う。body やヘッダーの tenant は読まない。
 * ★ (cores3) 登録簿との照合は **fail-closed** — 取れなければ保存せず 503 (キオスクは次の周期で
 *   送り直す)。取れたのに載っていない端末は 400。
 * ★ 報告の中身 (`phase` など) の検査は recorder が持つ。ここに写さない —
 *   recorder の 400 がそのまま返る。
 *
 * 純粋ロジックは server/utils/firmware-relay.ts、前段は server/utils/introspect-route.ts。
 */
// setResponseStatus は h3 から明示的に取る — auto-import に任せると、テスト環境では
// Nuxt のアプリ側の同名関数 (ブラウザでは何もしない) に解決され、status の素通しを検査できない
import { setResponseStatus } from 'h3'
import {
  buildOtaReportForward,
  decideFirmwareReportAccess,
  deviceIdFromTokenSub,
  isFirmwareDeviceId,
  loadDeviceLabels,
} from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker, recorder } = await introspectCaller(event)
  const access = decideFirmwareReportAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  const report = (await readBody(event).catch(() => undefined)) as Record<string, unknown> | null | undefined
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw createError({ statusCode: 400, statusMessage: 'body がありません' })
  }
  let forwarded: Record<string, unknown>
  if (report.kind === 'timecard') {
    // 指静脈端末: どの端末の報告かは token だけで決める (ほかの端末の行を書き換えさせない)
    const { deviceId } = deviceIdFromTokenSub(claims.sub)
    if (!isFirmwareDeviceId(deviceId)) {
      throw createError({ statusCode: 400, statusMessage: '端末の id がありません' })
    }
    forwarded = { ...report, device_id: deviceId }
  }
  else if (report.kind === 'cores3') {
    const deviceId = report.device_id
    if (!isFirmwareDeviceId(deviceId)) {
      throw createError({ statusCode: 400, statusMessage: 'device_id がありません' })
    }
    const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
    if (!labels) {
      throw createError({ statusCode: 503, statusMessage: '端末の一覧を取得できません' })
    }
    if (!labels.has(deviceId)) {
      throw createError({ statusCode: 400, statusMessage: '登録されていない端末です' })
    }
    forwarded = report
  }
  else {
    throw createError({ statusCode: 400, statusMessage: 'kind が不正です' })
  }

  const fwd = buildOtaReportForward({ sharedSecret, tenantId: access.tenantId, report: forwarded })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
