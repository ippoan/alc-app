import { test, expect } from '@playwright/test'
import { wakeUpStaging } from './helpers/staging'

// Import / Export は rust-alc-api (monolith) の `/staging/import`・`/staging/export` を叩く。
// rust の撤収でこの口は staging に無い (auth-worker の振り分け表にも、分割 worker にも無い) ため、
// それに依存するテストは skip する。worker を通る e2e は別 issue で足す (Refs ippoan/ci-dashboard#520)。
const MONOLITH_ONLY_REASON =
  'rust-alc-api 専用の /staging/import・/staging/export は staging に無い (Refs ippoan/ci-dashboard#520)'

test.describe('Staging ブートストラップ', () => {
  test.beforeAll(async () => {
    // staging の API の入口 (auth-worker) が応答するまで待つ。
    // テストデータの import (monolith 専用) は行わない (上の MONOLITH_ONLY_REASON)
    await wakeUpStaging()
  })

  test('ホームページが表示される (auth バイパス)', async ({ page }) => {
    await page.goto('/')
    // 測定画面の要素が表示されるまで待機
    await expect(page.locator('body')).toBeVisible()
    // ログインページにリダイレクトされないことを確認
    await page.waitForTimeout(2000)
    expect(page.url()).not.toContain('/login')
  })

  test('Staging フッターが表示される', async ({ page }) => {
    await page.goto('/')
    const footer = page.locator('text=STAGING')
    await expect(footer).toBeVisible()
  })

  test('Export ボタンが機能する', async ({ page }) => {
    test.skip(true, MONOLITH_ONLY_REASON)
    await page.goto('/')
    const exportButton = page.locator('button:has-text("Export")')
    await expect(exportButton).toBeVisible()

    // ダウンロードを待機
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ])
    expect(download.suggestedFilename()).toContain('staging-export-')
  })

  test('Import ボタンが機能する', async ({ page }) => {
    test.skip(true, MONOLITH_ONLY_REASON)
    await page.goto('/')
    const importButton = page.locator('button:has-text("Import")')
    await expect(importButton).toBeVisible()
  })
})
