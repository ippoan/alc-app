/**
 * `/api/proxy/*` の転送先 (auth-worker の route prefix) を決める (Refs #227)。
 *
 * auth-worker `/alc-proxy` は browser JWT 専用で device JWT を 401 にする。キオスクは
 * admin ログイン無しで device JWT を Bearer に載せて来るので、その場合だけ
 * `/device-data-proxy` (device JWT 用の経路) へ流す。
 *
 * **判定は auth-client の handler が実際に送る token で行う。** handler
 * (`createAuthWorkerProxyHandler` の resolveAuthToken) は cookie `logi_auth_token` を
 * Bearer より優先して送るので、cookie があれば Bearer が device JWT でも送られるのは
 * cookie 側 = `/alc-proxy`。
 *
 * **署名は検証しない** — ここは振り分けだけで、認証は転送先の auth-worker が全部やる。
 * 読めない token は `/alc-proxy` に倒す (従来どおりの経路)。
 */
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client/server'

export type ProxyPrefix = '/alc-proxy' | '/device-data-proxy'

/** auth-client の proxy handler が既定で読む cookie 名 (alc-app は cookieName を渡さない)。 */
export const AUTH_COOKIE_NAME = 'logi_auth_token'

export function selectProxyPrefix(input: {
  cookieToken?: string | null
  bearerToken?: string | null
}): ProxyPrefix {
  if (input.cookieToken || !input.bearerToken) return '/alc-proxy'
  const payload = decodeJwtPayloadFromToken(input.bearerToken) as { aud?: unknown } | null
  return payload?.aud === 'device' ? '/device-data-proxy' : '/alc-proxy'
}
