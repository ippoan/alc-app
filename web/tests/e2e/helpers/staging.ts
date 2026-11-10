import { requireStagingEnv } from './env'

// staging export/import の X-Staging-Key (rust-alc-api#391 opt-in 認証)。未設定なら送らない
const STAGING_API_KEY = process.env.STAGING_API_KEY || ''

function stagingHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) }
  if (STAGING_API_KEY) headers['X-Staging-Key'] = STAGING_API_KEY
  return headers
}

/**
 * staging の API の入口 (auth-worker) が応答するまでリトライする。最大 2 分間。
 * auth-worker の `/api/health` は auth-worker 自身の生死を返す (分割 worker には届かない)。
 */
export async function wakeUpStaging(): Promise<void> {
  const apiUrl = requireStagingEnv('STAGING_API_URL')
  const maxRetries = 24
  const interval = 5_000

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${apiUrl}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return
    } catch {
      // タイムアウトまたは接続エラー — リトライ
    }
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error('Staging API (auth-worker /api/health) did not become healthy within 2 minutes')
}

/**
 * テストデータを staging API にインポート
 *
 * rust-alc-api (monolith) 専用の口。rust の撤収で staging には無い (auth-worker も分割 worker も持たない)。
 * 使っていたテストは skip 中 (Refs ippoan/ci-dashboard#520)。
 */
export async function importTestData(data: object): Promise<void> {
  const res = await fetch(`${requireStagingEnv('STAGING_API_URL')}/staging/import`, {
    method: 'POST',
    headers: stagingHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Import failed: HTTP ${res.status} — ${body}`)
  }
}

/**
 * staging API からデータをエクスポート
 *
 * importTestData と同じく monolith 専用の口 (Refs ippoan/ci-dashboard#520)。
 */
export async function exportData(tenantId: string): Promise<object> {
  const res = await fetch(
    `${requireStagingEnv('STAGING_API_URL')}/staging/export?tenant_id=${tenantId}`,
    { headers: stagingHeaders() },
  )
  if (!res.ok) {
    throw new Error(`Export failed: HTTP ${res.status}`)
  }
  return res.json()
}
