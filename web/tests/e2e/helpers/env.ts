// staging e2e の接続先は env で必ず渡す。repo にホスト名を書かないため既定値は持たない
// (CI では repo variable から渡す。Refs ippoan/ci-dashboard#520)。
//   STAGING_APP_URL: staging の画面 (alc-app) の URL
//   STAGING_API_URL: staging の API の入口 (auth-worker) の URL
export const REQUIRED_STAGING_ENV = ['STAGING_APP_URL', 'STAGING_API_URL'] as const

export type StagingEnvName = (typeof REQUIRED_STAGING_ENV)[number]

export function requireStagingEnv(name: StagingEnvName): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. The staging e2e has no default host; pass ${name} (e.g. from the repo variable of the same name).`,
    )
  }
  return value.replace(/\/+$/, '')
}
