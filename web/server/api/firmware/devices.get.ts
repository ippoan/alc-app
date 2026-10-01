/**
 * 管理者の一覧: キオスクが報告した機体 (CoreS3) の版・更新の状態
 * (Refs ippoan/alc-app#403)。
 *
 * 経路: 管理者 (browser JWT を Bearer)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → cf-alc-recorder `GET /tenants/:t/ota-status`
 *   → auth-worker の登録簿からラベルを引いて各行に `label` を足す
 *
 * **dev ログインの token も通す** (読み取りだけ)。
 * ラベルは飾りなので、登録簿が取れなくても一覧は出す (`label: null`)。
 *
 * ★ tenant_id は introspect の結果だけを使う。
 */
// setResponseStatus は h3 から明示的に取る — auto-import に任せると、テスト環境では
// Nuxt のアプリ側の同名関数 (ブラウザでは何もしない) に解決され、status の素通しを検査できない
import { setResponseStatus } from 'h3'
import {
  buildOtaStatusForward,
  decideFirmwareAdminAccess,
  loadDeviceLabels,
  mergeFirmwareDevices,
} from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker, recorder } = await introspectCaller(event)
  const access = decideFirmwareAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  const fwd = buildOtaStatusForward({ sharedSecret, tenantId: access.tenantId })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (res.status !== 200) {
    setResponseStatus(event, res.status)
    return await res.text()
  }

  const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
  return mergeFirmwareDevices(await res.json(), labels)
})
