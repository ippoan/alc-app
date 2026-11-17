/**
 * 右下の版表示 (`VersionBadge`) の読み先 (Refs ippoan/alc-app-s3#352)。
 *
 * 認証なし・GET のみ。返すのは版の文字列だけ:
 * - `version` = この画面 (Nuxt の worker) の版。画面の `appVersion` と同じ runtimeConfig の値
 * - `auth_worker_version` = auth-worker の `/api/health` が返す版。service binding `AUTH_WORKER` で引く。
 *   binding が無い・失敗・2 秒で返らないときはキーごと省く (版表示は飾りなので 200 のまま返す)
 *
 * ★ 秘密・テナント・端末の情報は返さない。
 */
const AUTH_WORKER_HEALTH_URL = 'https://auth-worker.internal/api/health'
const AUTH_WORKER_TIMEOUT_MS = 2000

async function fetchAuthWorkerVersion(authWorker: { fetch: typeof fetch } | undefined): Promise<string | null> {
  if (!authWorker) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AUTH_WORKER_TIMEOUT_MS)
  })
  const lookup = (async () => {
    try {
      const res = await authWorker.fetch(AUTH_WORKER_HEALTH_URL, { method: 'GET' })
      if (res.status !== 200) return null
      const json = (await res.json()) as { auth_worker_version?: unknown } | null
      const v = json?.auth_worker_version
      return typeof v === 'string' && v ? v : null
    }
    catch {
      return null
    }
  })()
  try {
    return await Promise.race([lookup, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

export default defineEventHandler(async (event) => {
  const env = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
  const authWorkerVersion = await fetchAuthWorkerVersion(env.AUTH_WORKER as { fetch: typeof fetch } | undefined)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    status: 'ok',
    version: String(useRuntimeConfig(event).public.appVersion),
    ...(authWorkerVersion ? { auth_worker_version: authWorkerVersion } : {}),
  }
})
