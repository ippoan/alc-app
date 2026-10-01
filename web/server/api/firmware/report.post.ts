/**
 * キオスクのブラウザが、繋がっている機体 (CoreS3) の版・更新の状態を報告する
 * (Refs ippoan/alc-app#403)。
 *
 * 経路: キオスク (端末の token を Bearer + 報告の object)
 *   → 本 route: introspect → **role が `device-kiosk` の token だけ**通す
 *   → auth-worker の登録簿と照合 (`device_id` がこのテナントの未失効の端末か)
 *   → cf-alc-recorder `POST /tenants/:t/ota-report` (DO storage に保存)
 *
 * ★ tenant_id は introspect の結果だけを使う。body やヘッダーの tenant は読まない。
 * ★ 登録簿との照合は **fail-closed** — 取れなければ保存せず 503 (キオスクは次の周期で
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
  const deviceId = report.device_id
  if (!isFirmwareDeviceId(deviceId)) {
    throw createError({ statusCode: 400, statusMessage: 'device_id がありません' })
  }
  if (report.kind !== 'cores3') {
    throw createError({ statusCode: 400, statusMessage: 'kind が不正です' })
  }

  const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
  if (!labels) {
    throw createError({ statusCode: 503, statusMessage: '端末の一覧を取得できません' })
  }
  if (!labels.has(deviceId)) {
    throw createError({ statusCode: 400, statusMessage: '登録されていない端末です' })
  }

  const fwd = buildOtaReportForward({ sharedSecret, tenantId: access.tenantId, report })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
