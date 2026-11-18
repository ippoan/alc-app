/**
 * 右下の版の表示が「この画面がつかんでいる端末 1 台の名前」を読む口 (Refs ippoan/alc-app-s3#352)。
 * `GET /api/device-name?device_id=<id>` → `{ device_id, name: string | null }`。
 *
 * 名前の一覧 (`/api/cam-host-keys`・`/api/device-labels`) は管理者だけなので、運行管理者席・キオスクの画面
 * (管理者でない token) では引けず、予備の表記になって管理画面の一覧と食い違っていた。ここは 1 台ぶんだけ返す。
 *
 * 経路: 画面 (版の報告と同じ端末の token、または管理者の token を Bearer)
 *   → 本 route: introspect → 版の報告と同じ判定 (`decideFirmwareReportAccess`) に管理者を足した role だけ通す
 *   → device_id で相手を分ける:
 *     - `alarm-<指紋>` / `alarm:<指紋>` … auth-worker `GET /internal/alarm-keys/label` (失効は「 (失効)」付き)
 *     - それ以外 … auth-worker の登録簿 `/internal/device-labels` から **その 1 件だけ**取り出す
 *
 * ★ tenant_id は introspect の結果だけを使う。
 * ★ 他の端末の名前・一覧は返さない。
 * ★ 見つからない・auth-worker の失敗は `name: null` の 200 (版の表示は飾りなので画面を壊さない)。
 */
import { getQuery } from 'h3'
import {
  alarmKeyLabelName,
  buildAlarmKeyLabelForward,
  decideFirmwareReportAccess,
  DEVICE_NAME_READ_ROLES,
  loadDeviceLabels,
  renameTargetOf,
} from '../utils/firmware-relay'
import { introspectCaller } from '../utils/introspect-route'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker } = await introspectCaller(event)
  const access = decideFirmwareReportAccess(claims, DEVICE_NAME_READ_ROLES)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.status === 401 ? access.message : 'この token では端末の名前を読めません' })
  }
  const deviceId = getQuery(event).device_id
  const target = renameTargetOf(deviceId)
  if (!target) {
    throw createError({ statusCode: 400, statusMessage: 'device_id がありません' })
  }

  let name: string | null = null
  if (target.kind === 'key') {
    const fwd = buildAlarmKeyLabelForward({ sharedSecret, tenantId: access.tenantId, fingerprint: target.fingerprint })
    const res = await authWorker.fetch(fwd.url, fwd.init).catch(() => null)
    if (res?.status === 200) name = alarmKeyLabelName(await res.json().catch(() => null))
  }
  else {
    const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
    name = labels?.get(target.deviceId) ?? null
  }

  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { device_id: deviceId, name }
})
