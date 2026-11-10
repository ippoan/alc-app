import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // STAGING_APP_URL・STAGING_API_URL が未設定なら、ここで分かるメッセージで落とす (helpers/env.ts)
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 120_000, // staging コールドスタートに時間がかかるため
  retries: 1,
  reporter: 'html',
  use: {
    // 既定値は持たない (repo にホスト名を書かない。Refs ippoan/ci-dashboard#520)
    baseURL: process.env.STAGING_APP_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
