/**
 * 管理者の「最新を取る」: 購読中の全キオスクへ「指静脈の対応表を送って」の合図を出す
 * (Refs ippoan/alc-app#436)。
 *
 * 経路: 管理者 (browser JWT を Bearer)
 *   → 本 route: introspect → **role が `admin` の token だけ**通す
 *   → cf-alc-recorder `POST /tenants/:t/vein-list-request` (`{sent}` を返す)
 *
 * 合図は端末に何も書き込まない (キオスクが自分の対応表を報告するだけ) ので、
 * dev ログインの token も通す。body は読まない。
 */
// setResponseStatus は h3 から明示的に取る (firmware/update.post.ts と同じ理由)
import { setResponseStatus } from 'h3'
import { introspectCaller } from '../../utils/introspect-route'
import { buildVeinListForward, decideVeinFleetAdminAccess } from '../../utils/vein-fleet-relay'

export default defineEventHandler(async (event) => {
  const { claims, sharedSecret, recorder } = await introspectCaller(event)
  const access = decideVeinFleetAdminAccess(claims)
  if (!access.ok) {
    throw createError({ statusCode: access.status, statusMessage: access.message })
  }

  const fwd = buildVeinListForward({ sharedSecret, tenantId: access.tenantId, leaf: 'request' })
  const res = await recorder.fetch(fwd.url, fwd.init)
  setResponseStatus(event, res.status)
  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return await res.text()
})
