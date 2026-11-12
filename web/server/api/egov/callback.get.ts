/**
 * e-Gov のログインの戻り先 (`https://alc.ippoan.org/api/egov/callback`)。認可コードを worker `egov-prod` で
 * トークンに替え、HttpOnly の cookie に置いて元の画面へ戻す。失敗したら元の画面に `egov=ng` を付けて戻す。
 */
import { defineEventHandler, getQuery, sendRedirect } from 'h3'
import { callbackUrl, DEFAULT_RETURN, egovEnv, requestToken, saveTokens, takeState, withMark } from '../../utils/egov-session'

export default defineEventHandler(async (event) => {
  const { worker } = await egovEnv(event)
  const q = getQuery(event)
  const saved = takeState(event)
  const ret = saved?.ret ?? DEFAULT_RETURN
  if (!saved || q.state !== saved.state || typeof q.code !== 'string' || !q.code) {
    return sendRedirect(event, withMark(ret, 'egov=ng'), 302)
  }
  const token = await requestToken(worker, {
    grant_type: 'authorization_code',
    code: q.code,
    redirect_uri: callbackUrl(event),
    code_verifier: saved.verifier,
  })
  if (!token) return sendRedirect(event, withMark(ret, 'egov=ng'), 302)
  saveTokens(event, token)
  return sendRedirect(event, ret, 302)
})
