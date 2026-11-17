/**
 * 管理者の「更新する」: 指定した 1 台の機体 (CoreS3 / 指静脈端末) を更新する合図を出す
 * (Refs ippoan/alc-app#403, ippoan/alc-app-s3#352)。
 *
 * 経路: 管理者 (browser JWT を Bearer + `{device_id}`)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → cf-alc-recorder `GET /tenants/:t/ota-status` で、その端末の最後の報告の `kind` から
 *     target を引く (`cores3` → `cores3`、`timecard` → `timecard-station`)
 *   → cf-alc-recorder `POST /tenants/:t/serial-ota` (`{target, device_id}`)
 *   → recorder がテナントの購読キオスクへ合図を送る。実行するのは、その端末が
 *     繋がっているキオスクだけ
 *
 * ★ body から読むのは `device_id` だけ。**ファームの URL・版・target は読まない。**
 * ★ `device_id` は必須 — 無しで送ると合図が端末の指定なしで全キオスクへ出る
 *   (recorder は device_id 無しを弾かない)。報告の無い端末は 404 (target を決められない)。
 * ★ 状態 (いま更新中か等) は見ない。実行するかどうかはキオスク側と機体が決める。
 * ★ dev ログインの token は 403 (Refs ippoan/alc-app#162。利用者の role を持ち admin で
 *   ありうるので、ここで塞がないと通る)。
 */
// setResponseStatus は h3 から明示的に取る — auto-import に任せると、テスト環境では
// Nuxt のアプリ側の同名関数 (ブラウザでは何もしない) に解決され、status の素通しを検査できない
import { setResponseStatus } from 'h3'
import {
  buildOtaStatusForward,
  buildSerialOtaForward,
  decideFirmwareAdminAccess,
  firmwareTargetForDevice,
  isFirmwareDeviceId,
} from '../../utils/firmware-relay'
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

  const statusFwd = buildOtaStatusForward({ sharedSecret, tenantId: access.tenantId })
  const statusRes = await recorder.fetch(statusFwd.url, statusFwd.init)
  if (statusRes.status !== 200) {
    throw createError({ statusCode: 503, statusMessage: '端末の報告を取得できません' })
  }
  const found = firmwareTargetForDevice(await statusRes.json().catch(() => null), deviceId)
  if (!found.ok) {
    throw found.error === 'no_report'
      ? createError({ statusCode: 404, statusMessage: '報告の無い端末です' })
      : createError({ statusCode: 400, statusMessage: '更新できない種類の端末です' })
  }

  const fwd = buildSerialOtaForward({ sharedSecret, tenantId: access.tenantId, deviceId, target: found.target })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
