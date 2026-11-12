/**
 * e-Gov 本番へのログインを始める (点呼の届出の「申請済みの控え」で状況を出すため。Refs ippoan/alc-app#676)。
 * `?return=<同じ origin のパス>` に戻る。state と code_verifier は HttpOnly の cookie に 10 分だけ預ける。
 */
import { buildAuthorizationUrl, generatePKCE } from '@ippoan/egov-shinsei-sdk/auth'
import { defineEventHandler, getQuery, sendRedirect } from 'h3'
import { EGOV_AUTH_BASE, callbackUrl, egovEnv, safeReturn, saveState } from '../../utils/egov-session'

export default defineEventHandler(async (event) => {
  const { clientId } = await egovEnv(event)
  const { codeVerifier, codeChallenge } = await generatePKCE()
  const state = crypto.randomUUID()
  saveState(event, { state, verifier: codeVerifier, ret: safeReturn(getQuery(event).return) })
  return sendRedirect(event, buildAuthorizationUrl({
    authBase: EGOV_AUTH_BASE,
    clientId,
    redirectUri: callbackUrl(event),
    state,
    codeChallenge,
  }), 302)
})
