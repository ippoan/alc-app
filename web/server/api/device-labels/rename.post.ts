/**
 * 管理者の「名前を変える」: 端末の名前を auth-worker で書き換える (Refs ippoan/alc-app-s3#352)。
 *
 * 経路: 管理者 (browser JWT を Bearer + `{device_id, label}`)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す → dev ログインの token は 403
 *   → device_id で相手を分ける:
 *     - `alarm-<指紋>` / `alarm:<指紋>` (指静脈端末など鍵で取った端末) … 鍵のラベル。
 *       auth-worker `POST /device/setup/alarm-key/rename` (同じ JWT を cookie に載せる。一覧の
 *       `/api/cam-host-keys` と同じ方式)
 *     - それ以外 (CoreS3 など登録簿の端末) … auth-worker `POST /internal/device-labels/rename`
 *       (shared secret + introspect の tenant_id)
 *
 * ★ tenant_id は introspect の結果だけを使う (body から受けない)。
 * ★ label は前後の空白を落として 1〜64 字。だめなら auth-worker に投げる前に 400。
 * ★ auth-worker の 404 は 404、409 は 409 と `error` (`revoked` / `duplicate_label`) をそのまま返す。
 *   それ以外の失敗は 502 (詳細は返さない)。
 * ★ dev ログインの token は 403 (読み取りの `/api/device-labels` は通すが、書き込みは塞ぐ。
 *   firmware/update.post.ts と同じ)。
 */
import { setResponseStatus } from 'h3'
import { buildAlarmKeyRenameForward } from '../../utils/cam-host-keys'
import {
  buildDeviceLabelRenameForward,
  decideFirmwareAdminAccess,
  normalizeDeviceLabel,
  renameTargetOf,
} from '../../utils/firmware-relay'
import { introspectCaller } from '../../utils/introspect-route'
import { isDevLoginToken } from '../../utils/print-relay'

/** auth-worker の 409 の `error` のうち、画面へそのまま返すもの */
const CONFLICT_ERRORS: ReadonlySet<string> = new Set(['revoked', 'duplicate_label'])

export default defineEventHandler(async (event) => {
  const { token, claims, sharedSecret, authWorker } = await introspectCaller(event)
  const access = decideFirmwareAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.status === 401 ? access.message : '名前の変更は管理者のみ実行できます' })
  }
  // 判定するのは introspect が active を返した後 = 署名検証済み
  if (isDevLoginToken(token)) {
    throw createError({ statusCode: 403, statusMessage: 'dev_token_write_forbidden' })
  }

  const body = (await readBody(event).catch(() => undefined)) as { device_id?: unknown, label?: unknown } | null | undefined
  const target = renameTargetOf(body?.device_id)
  if (!target) {
    throw createError({ statusCode: 400, statusMessage: 'device_id がありません' })
  }
  const label = normalizeDeviceLabel(body?.label)
  if (!label) {
    throw createError({ statusCode: 400, statusMessage: '名前は 1〜64 文字で入力してください' })
  }

  const fwd = target.kind === 'key'
    ? buildAlarmKeyRenameForward(token, { fingerprint: target.fingerprint, label })
    : buildDeviceLabelRenameForward({ sharedSecret, tenantId: access.tenantId, deviceId: target.deviceId, label })
  const res = await authWorker.fetch(fwd.url, fwd.init).catch(() => null)

  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (res?.status === 200) {
    const json = (await res.json().catch(() => null)) as { label?: unknown } | null
    return { ok: true, device_id: body!.device_id, label: typeof json?.label === 'string' ? json.label : label }
  }
  if (res?.status === 404) {
    throw createError({ statusCode: 404, statusMessage: '端末が見つかりません' })
  }
  if (res?.status === 409) {
    const json = (await res.json().catch(() => null)) as { error?: unknown } | null
    const error = typeof json?.error === 'string' && CONFLICT_ERRORS.has(json.error) ? json.error : 'conflict'
    setResponseStatus(event, 409)
    return { error }
  }
  throw createError({ statusCode: 502, statusMessage: '名前を変えられませんでした' })
})
