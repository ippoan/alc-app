/**
 * 打刻の CSV (Refs ippoan/alc-cam#2)。backend の CSV の「デバイス」列を、端末の名前
 * (機体の鍵のラベル) に替えて返す。**他の列・列の位置・文字コード (UTF-8 + BOM)・ファイル名は変えない**。
 *
 * 経路: ブラウザ (Bearer の JWT)
 *   → 本 route: **同じ Bearer / cookie のまま** `/api/proxy/timecard/punches/csv` を内部 fetch
 *     (認証・ACL・dev 端末の振り分けは proxy が今までどおり決める。ここでは何も判定しない)
 *   → 200 のときだけ、呼び手が admin なら (introspect → role) auth-worker の鍵の一覧と登録簿で名前を引いて差し替える
 *
 * 名前は飾りなので、**名前を引けなくても CSV は返す** (admin でない・鍵の一覧が取れない → 元の CSV のまま)。
 * backend の失敗 (401/403/5xx など) は status と本文をそのまま返す。
 * 名前は cam-host-keys と同じ経路 (呼び手の管理者 JWT を cookie に載せて service binding) で引く。
 */
import { setResponseStatus } from 'h3'
import { deviceDisplayName } from '../../../../app/utils/device-name'
import { buildAlarmKeysForward, parseAlarmKeyNames } from '../../../utils/cam-host-keys'
import { decideFirmwareAdminAccess, loadDeviceLabelRows } from '../../../utils/firmware-relay'
import { introspectCaller } from '../../../utils/introspect-route'
import { renameDeviceColumn } from '../../../utils/timecard-csv'

/** backend の CSV を返す内部の口 (proxy)。クエリはそのまま渡す */
const PROXY_CSV_PATH = '/api/proxy/timecard/punches/csv'

/** 名前の表 (鍵のラベル + 登録簿)。取れなければ null */
async function loadNames(event: Parameters<typeof introspectCaller>[0]) {
  try {
    const { token, claims, sharedSecret, authWorker } = await introspectCaller(event)
    const access = decideFirmwareAdminAccess(claims)
    if (!access.ok) return null
    const fwd = buildAlarmKeysForward(token)
    const [keysRes, registry] = await Promise.all([
      authWorker.fetch(fwd.url, fwd.init),
      loadDeviceLabelRows(authWorker, { sharedSecret, tenantId: access.tenantId }, true),
    ])
    if (keysRes.status !== 200) return null
    return { keyNames: parseAlarmKeyNames(await keysRes.json()), registry: registry ?? [] }
  }
  catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const res = await event.fetch(`${PROXY_CSV_PATH}${getRequestURL(event).search}`, { method: 'GET' })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, res.status)
  // 本文の種類・保存名は backend のまま (CSV の `Content-Type` / `Content-Disposition`)
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h)
    if (v) setResponseHeader(event, h, v)
  }
  if (res.status !== 200) return await res.text()

  // BOM を残したまま読む (res.text() は BOM を落とす)
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer())
  const names = await loadNames(event)
  if (!names) return csv
  return renameDeviceColumn(csv, id => deviceDisplayName(id, names.keyNames, names.registry))
})
