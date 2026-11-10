import { test, expect } from '@playwright/test'
import { stagingE2eToken } from './helpers/env'
import { wakeUpStaging } from './helpers/staging'

// 画面と同じ経路 (same-origin `/api/proxy/*` → AUTH_WORKER binding の `/alc-proxy/*` →
// auth-worker の振り分け表 `ALC_BINDING_ROUTES` → 分割 worker) で、staging の worker に届くかを確かめる。
// 読み取り (GET) だけを叩く。書き込みはしない。
//
// 叩く口と届く worker (auth-worker の src/lib/alc-backend-route.ts の行と、wrangler.toml の
// [[env.staging.services]] で staging にも binding が在るものだけ):
//   GET /api/measurements → ALC_MEASUREMENTS → ippoan/alc-measurements-worker
//   GET /api/employees    → ALC_PEOPLE       → ippoan/alc-people-worker
// CI の compat 報告 (.github/workflows/test.yml の staging-e2e job) の backend_repos はこの 2 つと揃える。
//
// 認証は staging の read-only の dev token (env STAGING_E2E_TOKEN)。CI は GitHub OIDC で auth-worker の
// `POST /api/ci/staging-token` から取って渡す (Refs ippoan/auth-worker#752)。手元では dev-login の token を渡す。
// 無ければ skip する (CI は token が取れないとき e2e も compat の報告もしない)。Refs ippoan/alc-app#668、ippoan/ci-dashboard#520
const token = stagingE2eToken()

test.describe('Staging の分割 worker (読み取り)', () => {
  test.skip(!token, 'STAGING_E2E_TOKEN が無いので worker を通るテストは skip する')

  test.beforeAll(async () => {
    await wakeUpStaging()
  })

  const auth = () => ({ Authorization: `Bearer ${token}` })

  test('GET /api/measurements が alc-measurements-worker から返る', async ({ request }) => {
    const res = await request.get('/api/proxy/measurements?per_page=1', { headers: auth() })
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.measurements)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  test('GET /api/employees が alc-people-worker から返る', async ({ request }) => {
    const res = await request.get('/api/proxy/employees', { headers: auth() })
    expect(res.status(), await res.text()).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})
