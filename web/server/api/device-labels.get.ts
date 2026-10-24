/**
 * 管理者の画面で端末に名前を付ける: auth-worker の端末の登録簿 (鍵) のラベル一覧
 * (Refs ippoan/alc-cam#2)。
 *
 * 経路: 管理者 (browser JWT を Bearer)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → auth-worker `GET /internal/device-labels` (firmware/devices.get.ts と同じ登録簿)
 *
 * 応答にはテナントの全 role の端末が載るが、admin だけが読む前提で許容する。
 * ラベルは飾りなので、登録簿が取れなくても 200 `{devices: []}` で返す (画面は名前なしで出す)。
 *
 * ★ tenant_id は introspect の結果だけを使う。
 */
import { decideFirmwareAdminAccess, loadDeviceLabels } from '../utils/firmware-relay'
import { introspectCaller } from '../utils/introspect-route'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, authWorker } = await introspectCaller(event)
  const access = decideFirmwareAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  const labels = await loadDeviceLabels(authWorker, { sharedSecret, tenantId: access.tenantId })
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    devices: [...(labels ?? new Map<string, string | null>())].map(([device_id, label]) => ({ device_id, label })),
  }
})
