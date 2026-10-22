/**
 * 管理者の一覧: キオスクが報告した指静脈の対応表 (Refs ippoan/alc-app#436)。
 *
 * 経路: 管理者 (browser JWT を Bearer)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → cf-alc-recorder `GET /tenants/:t/vein-list-status`
 *   → auth-worker の登録簿からラベルを引いて各行に `label` を足す
 *
 * **dev ログインの token も通す** (読み取りだけ)。ラベルは飾りなので、登録簿が取れなくても
 * 一覧は出す (`label: null`)。
 *
 * ★ tenant_id は introspect の結果だけを使う。
 */
// setResponseStatus は h3 から明示的に取る (firmware/devices.get.ts と同じ理由)
import { setResponseStatus } from 'h3'
import { loadDeviceLabels, mergeFirmwareDevices } from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'
import { buildVeinListForward, decideVeinFleetAdminAccess } from '../../utils/vein-fleet-relay'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker, recorder } = await introspectCaller(event)
  const access = decideVeinFleetAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  const fwd = buildVeinListForward({ sharedSecret, tenantId: access.tenantId, leaf: 'status' })
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
