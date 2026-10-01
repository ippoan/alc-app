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
 * **例外は dev端末の Bearer だけ** (Refs ippoan/alc-app#387): Bearer が device JWT で claim
 * `dev_device` を持つときは、cookie があっても `/device-data-proxy` へ振り、送る token も
 * その Bearer にする ({@link BEARER_ONLY_COOKIE_NAME})。dev端末の記録は
 * `/device-data-proxy` を通ったときだけ dev の印が付く — 管理者ログインの cookie が残った
 * ブラウザから cookie の browser JWT で送ると、テストの記録が本番の行になる。
 * prefix だけ変えても足りない (cookie の browser JWT が `/device-data-proxy` に届いて 401)。
 *
 * **署名は検証しない** — ここは振り分けだけで、認証は転送先の auth-worker が全部やる。
 * 読めない token は `/alc-proxy` に倒す (従来どおりの経路)。
 */
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client/server'

export type ProxyPrefix = '/alc-proxy' | '/device-data-proxy'

/** auth-client の proxy handler が既定で読む cookie 名 (alc-app は cookieName を渡さない)。 */
export const AUTH_COOKIE_NAME = 'logi_auth_token'

/**
 * handler に cookie を読ませず Bearer を送らせるための cookie 名 (Refs ippoan/alc-app#387)。
 *
 * handler が送る token を route 側から選ぶ口は `cookieName` しか無い (cookie → Bearer の順は
 * handler の中で固定)。**`=` は cookie の名前になり得ない** (`名前=値` の区切りそのもの) ので、
 * この名前の cookie はどんなリクエストにも存在せず、handler は必ず Bearer へ進む。
 */
export const BEARER_ONLY_COOKIE_NAME = '='

interface ProxyTokens {
  cookieToken?: string | null
  bearerToken?: string | null
}

/** Bearer が dev端末の device JWT (`aud === 'device'` かつ `dev_device === true`) か。 */
export function isDevDeviceBearer(bearerToken?: string | null): boolean {
  if (!bearerToken) return false
  const payload = decodeJwtPayloadFromToken(bearerToken) as { aud?: unknown, dev_device?: unknown } | null
  return payload?.aud === 'device' && payload?.dev_device === true
}

export function selectProxyPrefix(input: ProxyTokens): ProxyPrefix {
  if (isDevDeviceBearer(input.bearerToken)) return '/device-data-proxy'
  if (input.cookieToken || !input.bearerToken) return '/alc-proxy'
  const payload = decodeJwtPayloadFromToken(input.bearerToken) as { aud?: unknown } | null
  return payload?.aud === 'device' ? '/device-data-proxy' : '/alc-proxy'
}

/**
 * handler に渡す `cookieName`。dev端末の Bearer のときだけ {@link BEARER_ONLY_COOKIE_NAME}
 * (= cookie を読ませない)、それ以外は従来どおり既定の cookie。
 */
export function selectProxyCookieName(input: ProxyTokens): string {
  return isDevDeviceBearer(input.bearerToken) ? BEARER_ONLY_COOKIE_NAME : AUTH_COOKIE_NAME
}
