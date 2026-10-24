/**
 * 録画タブの端末候補: テナントに登録済みの機体の鍵 (用途 kiosk / bp-station。label と `alarm:<fingerprint>`)。
 *
 * 経路: 管理者 (browser JWT を Bearer)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → auth-worker `GET /device/setup/alarm-keys` (同じ JWT を cookie に載せる。`~/server/utils/cam-host-keys`)
 *
 * 一覧の失敗は status をそのまま返す (画面は候補が出ないだけで、カメラの登録はできる)。
 */
import { setResponseStatus } from 'h3'
import { buildAlarmKeysForward, parseAlarmKeyNames, parseCamHostKeys } from '../utils/cam-host-keys'
import { decideFirmwareAdminAccess } from '../utils/firmware-relay'
import { introspectCaller } from '../utils/introspect-route'

export default defineEventHandler(async (event) => {
  const { token, claims, authWorker } = await introspectCaller(event)
  const access = decideFirmwareAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.status === 401 ? access.message : '管理者のみ参照できます' })
  }

  const fwd = buildAlarmKeysForward(token)
  const res = await authWorker.fetch(fwd.url, fwd.init)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (res.status !== 200) {
    setResponseStatus(event, res.status)
    return await res.text()
  }
  const json = await res.json()
  // keys = カメラの担当付けの候補 (kiosk だけ) / names = 名前付け用 (全用途・失効済み)
  return { keys: parseCamHostKeys(json), names: parseAlarmKeyNames(json) }
})
