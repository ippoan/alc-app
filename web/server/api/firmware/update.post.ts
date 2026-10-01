/**
 * 管理者の「更新する」: 指定した 1 台の機体 (CoreS3) を更新する合図を出す
 * (Refs ippoan/alc-app#403)。
 *
 * 経路: 管理者 (browser JWT を Bearer + `{device_id}`)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → cf-alc-recorder `POST /tenants/:t/serial-ota` (`{target:"cores3", device_id}`)
 *   → recorder がテナントの購読キオスクへ合図を送る。実行するのは、その端末が
 *     繋がっているキオスクだけ
 *
 * ★ body から読むのは `device_id` だけ。**ファームの URL・版・target は読まない。**
 * ★ `device_id` は必須 — 無しで送ると合図が端末の指定なしで全キオスクへ出る
 *   (recorder は `cores3` で device_id 無しを弾かない)。
 * ★ 状態 (いま更新中か等) は見ない。実行するかどうかはキオスク側と機体が決める。
 * ★ dev ログインの token は 403 (Refs ippoan/alc-app#162。利用者の role を持ち admin で
 *   ありうるので、ここで塞がないと通る)。
 */
// setResponseStatus は h3 から明示的に取る — auto-import に任せると、テスト環境では
// Nuxt のアプリ側の同名関数 (ブラウザでは何もしない) に解決され、status の素通しを検査できない
import { setResponseStatus } from 'h3'
import { buildSerialOtaForward, decideFirmwareAdminAccess, isFirmwareDeviceId } from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'
import { isDevLoginToken } from '../../utils/print-relay'

export default defineEventHandler(async (event) => {
  const { token, claims, sharedSecret, recorder } = await introspectCaller(event)
  const access = decideFirmwareAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }
  // 判定するのは introspect が active を返した後 = 署名検証済み
  if (isDevLoginToken(token)) {
    throw createError({ statusCode: 403, statusMessage: 'dev_token_write_forbidden' })
  }

  const body = (await readBody(event).catch(() => undefined)) as { device_id?: unknown } | null | undefined
  const deviceId = body?.device_id
  if (!isFirmwareDeviceId(deviceId)) {
    throw createError({ statusCode: 400, statusMessage: 'device_id がありません' })
  }

  const fwd = buildSerialOtaForward({ sharedSecret, tenantId: access.tenantId, deviceId })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
