/**
 * e-Gov からログアウトする: refresh token を e-Gov で失効させ (worker `egov-prod` の `/logout`)、cookie を消す。
 * 触るのはこのブラウザの e-Gov の cookie だけ (alc のデータは変えない)。
 */
import { defineEventHandler, getCookie } from 'h3'
import { REFRESH_COOKIE, clearTokens, egovEnv } from '../../utils/egov-session'

export default defineEventHandler(async (event) => {
  const { worker } = await egovEnv(event)
  const rt = getCookie(event, REFRESH_COOKIE)
  if (rt) {
    await worker.fetch(new Request('https://egov-worker/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })).catch(() => null)
  }
  clearTokens(event)
  return { ok: true }
})
