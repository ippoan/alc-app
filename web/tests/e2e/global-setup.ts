import { REQUIRED_STAGING_ENV, requireStagingEnv } from './helpers/env'

// 実行の前に、接続先の env が揃っているかを確かめる (`playwright test --list` では走らない)。
export default function globalSetup(): void {
  for (const name of REQUIRED_STAGING_ENV) requireStagingEnv(name)
}
