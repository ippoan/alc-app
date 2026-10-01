// api.ts の**トークンの選び方 — dev端末** (Refs ippoan/alc-app#387)。
//
// dev端末 (開発用の鍵) の記録は、端末の鍵のトークンで送ったときだけ dev の印が付く。
// 管理者ログインが残ったブラウザが管理者のトークンで送ると本番の行になるので、
// **端末の鍵が dev だと分かっているあいだは、admin JWT があっても端末の鍵で送る**。
// ここで固定するのは決定点ごとの「送信に付くのはどのトークンか」:
//
//   - `request()` (既定の scope)
//   - scope `'manager-device'` (点呼予定の CRUD) / `'bp-station'`
//   - `proxyRawFetch` (顔写真・音声・呼気動画・添付のアップロードと取得)
//   - `punchTimecard` (ブラウザ打刻、`bearerRequest` の直呼び)
//
// dev でない端末・印がまだ無い端末は今までの優先順位 (admin が先) のまま — そちらは既存の
// api.test.ts / api-manager-scope.test.ts / api-bp-station-scope.test.ts が期待を変えずに通る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi,
  MANAGER_DEVICE_AUTH_FAILED_MESSAGE, BP_STATION_DEVICE_AUTH_FAILED_MESSAGE,
  getEmployees, getEmployeeByCode, getEmployeeById, getTenkoSession, submitManagerJudgment, getDriverInfo,
  listTenkoSessions,
  startTenkoSession,
  listSchedules, createSchedule, deleteSchedule,
  startMeasurement,
  uploadFacePhoto, uploadReportAudio, uploadBlowVideo, fetchFacePhoto, fetchMeasurementVideo,
  uploadGuidanceAttachment,
  punchTimecard,
} from '~/utils/api'
import { noteDeviceToken, type DeviceTokenKind } from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const API_BASE = 'https://api.example.test'
const ADMIN_JWT = browserJwt()
const DEV_KIOSK_JWT = devDeviceJwt('dev-kiosk')
const DEV_MANAGER_JWT = devDeviceJwt('dev-manager')
const DEV_BP_JWT = devDeviceJwt('dev-bp')
const PLAIN_KIOSK_JWT = plainDeviceJwt('kiosk')
const PLAIN_MANAGER_JWT = plainDeviceJwt('manager')
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

let fetchMock: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>
let managerGetter: ReturnType<typeof vi.fn>
let bpGetter: ReturnType<typeof vi.fn>

function okJson(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
    blob: async () => new Blob(['x']),
  }
}

/** n 番目の fetch の [url, Authorization, X-Tenant-ID]。 */
function sent(n = 0): { url: string, bearer: string | null, tenant: string | null } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined]
  const h = new Headers(init?.headers)
  return { url, bearer: h.get('Authorization'), tenant: h.get('X-Tenant-ID') }
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson({ url: 'https://files.example.test/x' }))
  vi.stubGlobal('fetch', fetchMock)
  kioskGetter = vi.fn(async () => DEV_KIOSK_JWT as string | null)
  managerGetter = vi.fn(async () => DEV_MANAGER_JWT as string | null)
  bpGetter = vi.fn(async () => DEV_BP_JWT as string | null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const kind of KINDS) noteDeviceToken(kind, null)
  localStorage.clear()
})

/** 管理者ログインが残ったブラウザ (admin JWT あり) + 端末の getter 3 本。 */
function initWithAdmin(opts: { bp?: boolean } = {}) {
  initApi(
    API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined,
    kioskGetter, managerGetter, opts.bp ? bpGetter : undefined,
  )
}

describe('request() — 既定の scope (キオスクの鍵)', () => {
  it('★ admin JWT + dev のキオスク → 送信に付くのは端末の鍵のトークン (proxy 経由)', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await startTenkoSession({ employee_id: 'e1' } as never)

    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(sent().url).toBe('/api/proxy/tenko/sessions/start')
    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it('admin JWT + dev でないキオスク → admin JWT (今までどおり。端末の getter は呼ばない)', async () => {
    noteDeviceToken('kiosk', PLAIN_KIOSK_JWT)
    initWithAdmin()

    await getEmployees()

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('印がまだ無い (端末のトークンを一度も取れていない) → admin JWT (待ちを足さない)', async () => {
    initWithAdmin()

    await getEmployees()

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('dev のキオスクでトークンが取れなくても admin JWT へは戻さない (管理者ログインが無い端末と同じ経路)', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    kioskGetter.mockResolvedValue(null)
    initWithAdmin()

    await getEmployees()

    // 従来の「認証情報なし」の経路 = X-Tenant-ID の直 fetch。Authorization は付かない
    expect(sent().url).toBe(`${API_BASE}/api/employees`)
    expect(sent().bearer).toBeNull()
    expect(sent().tenant).toBe('test-tenant')
  })

  it('運行管理者席の印だけが dev でも、既定の scope は admin JWT のまま (見るのはキオスクの印)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await getEmployees()

    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })
})

describe("request() — scope 'manager-device' (点呼予定の CRUD)", () => {
  it.each([
    ['listSchedules', () => listSchedules()],
    ['createSchedule', () => createSchedule({ employee_id: 'e1', tenko_type: 'pre_operation', scheduled_at: '2026-01-01T00:00:00Z' } as never)],
    ['deleteSchedule', () => deleteSchedule('s1')],
  ])('★ admin JWT + dev の運行管理者席 → %s は運行管理者席の鍵のトークンで送る', async (_name, call) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await call()

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().url).toContain('/api/proxy/tenko/schedules')
    expect(sent().bearer).toBe(`Bearer ${DEV_MANAGER_JWT}`)
  })

  it('admin JWT + dev でない運行管理者席 → admin JWT (今までどおり)', async () => {
    noteDeviceToken('manager-device', PLAIN_MANAGER_JWT)
    initWithAdmin()

    await listSchedules()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('キオスクの印だけが dev でも、予定の口は admin JWT のまま (見るのは運行管理者席の印)', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await listSchedules()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('dev の運行管理者席でトークンが取れなければ、admin JWT へ戻さず理由を投げる', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(listSchedules()).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('運行管理者 getter が無い環境の予定の口はキオスクの鍵へ進むので、見る印もキオスクのもの', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter)

    await listSchedules()

    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })
})

describe("request() — scope 'bp-station' (測定台と点呼の共用 4 本)", () => {
  it('★ admin JWT + dev の測定台 → 測定台の鍵のトークンで送る', async () => {
    noteDeviceToken('bp-station', DEV_BP_JWT)
    initWithAdmin({ bp: true })

    await startMeasurement('e1')

    expect(bpGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${DEV_BP_JWT}`)
  })

  it('dev の測定台でトークンが取れなければ、admin JWT へ戻さず理由を投げる', async () => {
    noteDeviceToken('bp-station', DEV_BP_JWT)
    bpGetter.mockResolvedValue(null)
    initWithAdmin({ bp: true })

    await expect(startMeasurement('e1')).rejects.toThrow(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★ 測定台の getter が無い画面 (= キオスク) では、共用の 4 本も dev のキオスクの鍵で送る', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await startMeasurement('e1')

    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it('admin JWT + dev でない端末 → admin JWT (今までどおり)', async () => {
    initWithAdmin({ bp: true })

    await startMeasurement('e1')

    expect(bpGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })
})

describe('proxyRawFetch — アップロードと取得', () => {
  const blob = () => new Blob(['x'], { type: 'application/octet-stream' })

  it.each([
    ['uploadFacePhoto', '/api/proxy/upload/face-photo', () => uploadFacePhoto(blob())],
    ['uploadReportAudio', '/api/proxy/upload/report-audio', () => uploadReportAudio(blob())],
    ['uploadBlowVideo', '/api/proxy/upload/blow-video', () => uploadBlowVideo(blob())],
    ['fetchFacePhoto', '/api/proxy/measurements/m1/face-photo', () => fetchFacePhoto('m1')],
    ['fetchMeasurementVideo', '/api/proxy/measurements/m1/video', () => fetchMeasurementVideo('m1')],
    ['uploadGuidanceAttachment', '/api/proxy/guidance-records/r1/attachments', () => uploadGuidanceAttachment('r1', new File(['x'], 'a.png'))],
  ])('★ admin JWT + dev のキオスク → %s に付くのは端末の鍵のトークン', async (_name, url, call) => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await call()

    expect(sent().url).toBe(url)
    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it('admin JWT + dev でないキオスク → admin JWT (今までどおり。端末の getter は呼ばない)', async () => {
    noteDeviceToken('kiosk', PLAIN_KIOSK_JWT)
    initWithAdmin()

    await uploadFacePhoto(blob())

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('dev のキオスクでトークンが取れなくても admin JWT へは戻さない (直叩き fallback)', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    kioskGetter.mockResolvedValue(null)
    initWithAdmin()

    await uploadFacePhoto(blob())

    expect(sent().url).toBe(`${API_BASE}/api/upload/face-photo`)
    expect(sent().bearer).toBeNull()
  })
})

describe('punchTimecard — ブラウザ打刻 (bearerRequest の直呼び)', () => {
  it('★ admin JWT + dev のキオスク → 打刻に付くのは端末の鍵のトークン', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await punchTimecard('CARD-1')

    expect(sent().url).toBe('/api/timecard/punch')
    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it('admin JWT + dev でないキオスク → admin JWT (今までどおり)', async () => {
    noteDeviceToken('kiosk', PLAIN_KIOSK_JWT)
    initWithAdmin()

    await punchTimecard('CARD-2')

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('dev のキオスクでトークンが取れなければ、admin JWT で打たずに未ペアリングとして失敗する', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    kioskGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(punchTimecard('CARD-3')).rejects.toMatchObject({ punchFailure: 'unpaired' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// 遠隔点呼モニターの口 (`'tenko-monitor'`)。**運行管理者席の鍵が dev のときだけ**その鍵で送り、
// dev でなければ `'default'` とまったく同じ送り方になる (本番の席の挙動を変えない)。
describe("request() — scope 'tenko-monitor' (遠隔点呼モニター)", () => {
  /** モニターが `'tenko-monitor'` を付けて呼ぶ 6 本 + IT点呼 の受け画面が呼ぶ一覧。 */
  const MONITOR_CALLS: [string, () => Promise<unknown>, string][] = [
    ['getEmployees', () => getEmployees('tenko-monitor'), '/api/proxy/employees'],
    ['getEmployeeByCode', () => getEmployeeByCode('c 1', 'tenko-monitor'), '/api/proxy/employees/by-code/c%201'],
    ['getEmployeeById', () => getEmployeeById('e1', 'tenko-monitor'), '/api/proxy/employees/e1'],
    ['getTenkoSession', () => getTenkoSession('s1', 'tenko-monitor'), '/api/proxy/tenko/sessions/s1'],
    ['submitManagerJudgment', () => submitManagerJudgment('s1', { judgment: 'ok' } as never, 'tenko-monitor'), '/api/proxy/tenko/sessions/s1/judgment'],
    ['getDriverInfo', () => getDriverInfo('e1', 'tenko-monitor'), '/api/proxy/tenko/driver-info/e1'],
    ['listTenkoSessions', () => listTenkoSessions({ judgment_pending: true }, 'tenko-monitor'), '/api/proxy/tenko/sessions?judgment_pending=true'],
  ]

  it('運行管理者席の印なし + admin JWT あり → admin JWT で送る (\'default\' と同じ)', async () => {
    initWithAdmin()

    await getEmployees('tenko-monitor')
    await getEmployees()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent(0)).toEqual(sent(1))
    expect(sent(0)).toEqual({ url: '/api/proxy/employees', bearer: `Bearer ${ADMIN_JWT}`, tenant: null })
  })

  it('運行管理者席の印なし + admin JWT なし → キオスクの鍵で送る (\'default\' と同じ)', async () => {
    kioskGetter.mockResolvedValue(PLAIN_KIOSK_JWT)
    initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter)

    await getEmployees('tenko-monitor')
    await getEmployees()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(kioskGetter).toHaveBeenCalledTimes(2)
    expect(sent(0)).toEqual(sent(1))
    expect(sent(0).bearer).toBe(`Bearer ${PLAIN_KIOSK_JWT}`)
  })

  it('印が立っているのがキオスクだけなら、運行管理者席の鍵は使わない (\'default\' と同じ)', async () => {
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    initWithAdmin()

    await getEmployees('tenko-monitor')
    await getEmployees()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent(0)).toEqual(sent(1))
    expect(sent(0).bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it.each(MONITOR_CALLS)('★ 運行管理者席の印あり + admin JWT あり → %s は運行管理者席の鍵で送る', async (_name, call, url) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await call()

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${DEV_MANAGER_JWT}`, tenant: null })
  })

  it.each(MONITOR_CALLS)('scope を渡さない %s は、運行管理者席の印があっても今までどおり admin JWT', async (name) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()
    const plain: Record<string, () => Promise<unknown>> = {
      getEmployees: () => getEmployees(),
      getEmployeeByCode: () => getEmployeeByCode('c 1'),
      getEmployeeById: () => getEmployeeById('e1'),
      getTenkoSession: () => getTenkoSession('s1'),
      submitManagerJudgment: () => submitManagerJudgment('s1', { judgment: 'ok' } as never),
      getDriverInfo: () => getDriverInfo('e1'),
      listTenkoSessions: () => listTenkoSessions({ judgment_pending: true }),
    }

    await plain[name]!()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('★ 印あり + 運行管理者席の鍵が取れない → 理由を投げる (admin JWT にもキオスクの鍵にも落とさない)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(getTenkoSession('s1', 'tenko-monitor')).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('★ 印あり + 運行管理者席の getter が未登録 → 同じ理由を投げる (admin JWT もキオスクの鍵も使わない)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter)

    await expect(getTenkoSession('s1', 'tenko-monitor')).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
