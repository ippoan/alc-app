/**
 * キオスク API proxy: `/api/proxy/<path>` → rust-alc-api `/api/<path>`
 *
 * #434 Option ① (proxy + service binding) の本体。キオスク端末 (device JWT,
 * role=device-kiosk) からの呼び出しを:
 *   leg A: auth-worker `/auth/introspect` を **CF service binding** で叩いて検証
 *          (device JWT の署名 + ACL を auth-worker に集約。rust 側では検証しない)
 *   leg B: 検証済み tenant_id を `X-Tenant-ID` に載せて rust-alc-api へ転送
 *          (device JWT 自体は転送しない)。proxy 真正性は Cloud Run の網層
 *          ロックダウンで担保するため `X-Tenant-Proxy-Secret` は使わない (#434 B案)。
 * の 2 段で中継する。
 *
 * 管理者経路 (rust-alc-api 署名の Google OAuth JWT) は proxy を経由せず `utils/api.ts`
 * から直 fetch で良い (rust-alc-api が Authorization を直接検証できるため)。本 route は
 * キオスク (bare X-Tenant-ID を device JWT 経由に置き換える) 専用。
 *
 * NOTE: 本 route は step 3a (infra) として先行投入する。実際にキオスクが device JWT
 * を送るよう切替えるのは step 3b/3c (utils/api.ts + useAuth の device JWT 配線)。
 * 切替前は caller が居ないため inert。本 PR 単体では既存挙動を一切変えない。
 */
import {
  buildTargetUrl,
  classifyProxyResponse,
  introspectToken,
  parseJsonBody,
} from '@ippoan/auth-client/server'
import {
  bearerToken,
  buildKioskForwardHeaders,
  cfEnv,
  DEVICE_ROLE_KIOSK,
  resolveSecret,
} from '../../utils/kiosk-proxy'

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const config = useRuntimeConfig(event)

  // introspect の認証に使う shared secret (auth-worker resolveAllSharedSecrets と対)。
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding 未設定' })
  }

  // leg A は公開 HTTP ではなく CF service binding (worker-to-worker) で叩く。
  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
  if (!authWorker) {
    throw createError({ statusCode: 503, statusMessage: 'AUTH_WORKER service binding 未設定' })
  }

  const token = bearerToken(getHeader(event, 'authorization'))
  const result = await introspectToken({
    authWorkerUrl: (config.public.authWorkerUrl as string) || 'https://auth.ippoan.org',
    sharedSecret,
    token,
    origin: getRequestURL(event).origin,
    fetchImpl: (input, init) =>
      authWorker.fetch(input as Parameters<typeof fetch>[0], init as RequestInit),
  })

  // device-kiosk role の有効な device JWT 以外は 401 (bare X-Tenant-ID 直叩きを拒否)。
  if (!result.active || result.role !== DEVICE_ROLE_KIOSK) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const path = getRouterParam(event, 'path') || ''
  const backendUrl = (config.public.apiBase as string) || 'https://alc-api.ippoan.org'
  const url = buildTargetUrl(backendUrl, '/api/', path, getQuery(event))

  const headers = buildKioskForwardHeaders({
    contentType: getHeader(event, 'content-type'),
    tenantId: result.tenant_id,
  })

  const method = event.method
  const fetchOptions: RequestInit = { method, headers }
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try {
      const body = await readBody(event)
      if (body) {
        fetchOptions.body = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
      }
    } catch {
      // body なし (DELETE 等)
    }
  }

  const response = await fetch(url, fetchOptions)

  const responseContentType = response.headers.get('content-type')
  if (responseContentType) setHeader(event, 'content-type', responseContentType)
  const contentDisposition = response.headers.get('content-disposition')
  if (contentDisposition) setHeader(event, 'content-disposition', contentDisposition)
  setResponseStatus(event, response.status)

  switch (classifyProxyResponse(response.status, responseContentType, path)) {
    case 'binary':
      return new Uint8Array(await response.arrayBuffer())
    case 'empty':
      return null
    case 'json':
      return parseJsonBody(await response.text())
  }
})
