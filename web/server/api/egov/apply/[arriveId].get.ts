/**
 * 到達番号ごとの e-Gov での状況 (ステータス・通知と公文書の件数)。点呼の届出の「申請済みの控え」の行に出す
 * (Refs ippoan/alc-app#676)。e-Gov の `GET /apply/{到達番号}` を worker `egov-prod` 経由で呼ぶ。
 *
 * 経路: 管理者 (browser JWT を Bearer + e-Gov の cookie) → 本 route: introspect → **role が `admin` だけ** →
 * e-Gov。e-Gov のトークンは cookie から読む (画面の JS には無い)。ログインが要るときは 401 `egov_login_required`。
 */
import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3'
import { introspectCaller } from '../../../utils/introspect-route'
import { ARRIVE_ID, egovEnv, egovGet, summarizeApply } from '../../../utils/egov-session'

export default defineEventHandler(async (event) => {
  const { claims } = await introspectCaller(event)
  if (!claims.active || !claims.tenant_id) {
    throw createError({ statusCode: 401, statusMessage: 'token が無効です' })
  }
  if (claims.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'システム管理者だけが見られます' })
  }
  const arriveId = getRouterParam(event, 'arriveId') ?? ''
  if (!ARRIVE_ID.test(arriveId)) {
    throw createError({ statusCode: 400, statusMessage: '到達番号の形ではありません' })
  }
  const { worker } = await egovEnv(event)
  const res = await egovGet<{ results: Parameters<typeof summarizeApply>[0] }>(event, worker, `/apply/${arriveId}`)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return summarizeApply(res.results)
})
