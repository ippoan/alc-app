// 運行管理者席 (PC には席の鍵だけ。dev端末) の**読み取り**が、席の鍵で送られること。
//
// 席の鍵が dev だと分かっているとき、`'tenko-monitor'` は `'manager-device'` に解け、admin JWT が
// あっても席の鍵で送る。dev でなければ今までどおり (admin → キオスク)。書き込みは scope を付けない。
// raw fetch (顔写真・動画・CSV) も `request()` と同じ規則で、席の鍵が取れなければ
// MANAGER_DEVICE_AUTH_FAILED_MESSAGE で止める (キオスクの鍵にも無認証にも落とさない)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi, MANAGER_DEVICE_AUTH_FAILED_MESSAGE,
  getMeasurement, getTenkoDashboard, listBaselines, listFailures, listTimecardCards, listTimePunches,
  listDevices, listPendingDeviceRegistrations, getCarryingItems, getVehicleCategories,
  getDtakoDrivers, getDtakoDailyHours,
  fetchFacePhoto, fetchMeasurementVideo,
  downloadTenkoRecordsCsv, downloadFailuresCsv, downloadTimePunchesCsv,
} from '~/utils/api'
import { noteDeviceToken, type DeviceTokenKind } from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const API_BASE = 'https://api.example.test'
const ADMIN_JWT = browserJwt()
const DEV_MANAGER_JWT = devDeviceJwt('dev-manager')
const PLAIN_MANAGER_JWT = plainDeviceJwt('manager')
const PLAIN_KIOSK_JWT = plainDeviceJwt('kiosk')
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

let fetchMock: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>
let managerGetter: ReturnType<typeof vi.fn>

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

function sent(n = 0): { url: string, bearer: string | null } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined]
  return { url, bearer: new Headers(init?.headers).get('Authorization') }
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson([]))
  vi.stubGlobal('fetch', fetchMock)
  kioskGetter = vi.fn(async () => PLAIN_KIOSK_JWT as string | null)
  managerGetter = vi.fn(async () => DEV_MANAGER_JWT as string | null)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/x')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const kind of KINDS) noteDeviceToken(kind, null)
  localStorage.clear()
})

function initWithAdmin() {
  initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter, managerGetter)
}

/** 席の鍵だけの PC (管理者ログインなし) */
function initSeatOnly() {
  initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter)
}

const READS: [string, (scope: never) => Promise<unknown>, string][] = [
  ['getMeasurement', s => getMeasurement('m1', s), '/api/proxy/measurements/m1'],
  ['getTenkoDashboard', s => getTenkoDashboard(s), '/api/proxy/tenko/dashboard'],
  ['listBaselines', s => listBaselines(s), '/api/proxy/tenko/health-baselines'],
  ['listFailures', s => listFailures({}, s), '/api/proxy/tenko/equipment-failures'],
  ['listTimecardCards', s => listTimecardCards(undefined, s), '/api/proxy/timecard/cards'],
  ['listTimecardCards(employee)', s => listTimecardCards('e1', s), '/api/proxy/timecard/cards?employee_id=e1'],
  ['listTimePunches', s => listTimePunches({}, s), '/api/proxy/timecard/punches'],
  ['listDevices', s => listDevices(s), '/api/proxy/devices'],
  ['listPendingDeviceRegistrations', s => listPendingDeviceRegistrations(s), '/api/proxy/devices/pending'],
  ['getCarryingItems', s => getCarryingItems(s), '/api/proxy/carrying-items'],
  ['getVehicleCategories', s => getVehicleCategories(s), '/api/proxy/car-inspections/vehicle-categories'],
  ['getDtakoDrivers', s => getDtakoDrivers(s), '/api/proxy/drivers'],
  ['getDtakoDailyHours', s => getDtakoDailyHours({}, s), '/api/proxy/daily-hours'],
]

describe("読み取り (request) — scope 'tenko-monitor'", () => {
  it.each(READS)('★ 席の鍵が dev + admin JWT あり → %s は席の鍵で送る', async (_n, call, url) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await call('tenko-monitor' as never)

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${DEV_MANAGER_JWT}` })
  })

  it.each(READS)('席の鍵が dev でない + admin JWT あり → %s は今までどおり admin JWT', async (_n, call, url) => {
    noteDeviceToken('manager-device', PLAIN_MANAGER_JWT)
    initWithAdmin()

    await call('tenko-monitor' as never)

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${ADMIN_JWT}` })
  })

  it.each(READS)('scope を渡さない %s は、席の鍵が dev でも今までどおり admin JWT', async (_n, call) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await call(undefined as never)

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('★ 席の鍵が dev で取れない → 理由を投げる (admin JWT にもキオスクの鍵にも落とさない)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(getTenkoDashboard('tenko-monitor')).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('raw fetch (顔写真・動画) — scope', () => {
  it.each([
    ['fetchFacePhoto', '/api/proxy/measurements/m1/face-photo', (s?: never) => fetchFacePhoto('m1', s)],
    ['fetchMeasurementVideo', '/api/proxy/measurements/m1/video', (s?: never) => fetchMeasurementVideo('m1', s)],
  ])('★ 席の鍵が dev + admin JWT あり → %s は席の鍵で送る', async (_n, url, call) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    expect(await call('tenko-monitor' as never)).toBe('blob:test/x')

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${DEV_MANAGER_JWT}` })
  })

  it.each([
    ['fetchFacePhoto', (s?: never) => fetchFacePhoto('m1', s)],
    ['fetchMeasurementVideo', (s?: never) => fetchMeasurementVideo('m1', s)],
  ])('%s: 席の鍵が dev でない + admin JWT あり → admin JWT (今までどおり)', async (_n, call) => {
    noteDeviceToken('manager-device', PLAIN_MANAGER_JWT)
    initWithAdmin()

    await call('tenko-monitor' as never)

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('scope を渡さない顔写真は、席の鍵が dev でも admin JWT (キオスク側の規則のまま)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await fetchFacePhoto('m1')

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it("'manager-device' を直接渡す: admin JWT が無ければ席の鍵 (dev の印が無くても)", async () => {
    initSeatOnly()

    await fetchFacePhoto('m1', 'manager-device')

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${DEV_MANAGER_JWT}`)
  })

  it("'manager-device' を直接渡す: dev でない席 + admin JWT → admin JWT", async () => {
    noteDeviceToken('manager-device', PLAIN_MANAGER_JWT)
    initWithAdmin()

    await fetchFacePhoto('m1', 'manager-device')

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('★ 席の鍵が取れない → 送信せず null (キオスクの鍵にも無認証にも落とさない)', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    expect(await fetchFacePhoto('m1', 'tenko-monitor')).toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(kioskGetter).not.toHaveBeenCalled()
  })

  it("席の getter が無い環境の 'manager-device' はキオスクの規則へ進む (今までどおり)", async () => {
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter)

    await fetchFacePhoto('m1', 'manager-device')

    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('★ 席が dev なのに getter が無い → tenko-monitor は理由を投げる', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter)

    expect(await fetchFacePhoto('m1', 'tenko-monitor')).toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('CSV ダウンロード — scope', () => {
  let click: ReturnType<typeof vi.fn>

  beforeEach(() => {
    click = vi.fn()
    vi.spyOn(document, 'createElement').mockReturnValue({ click, href: '', download: '' } as never)
  })

  const CSVS: [string, string, (s?: never) => Promise<void>][] = [
    ['downloadTenkoRecordsCsv', '/api/proxy/tenko/records/csv', s => downloadTenkoRecordsCsv({}, s)],
    ['downloadFailuresCsv', '/api/proxy/tenko/equipment-failures/csv', s => downloadFailuresCsv({}, s)],
  ]

  it.each(CSVS)('★ 席の鍵が dev + admin JWT あり → %s は席の鍵で送る', async (_n, url, call) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await call('tenko-monitor' as never)

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${DEV_MANAGER_JWT}` })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it.each(CSVS)('%s: 席の鍵が dev でない + admin JWT あり → admin JWT (今までどおり)', async (_n, url, call) => {
    noteDeviceToken('manager-device', PLAIN_MANAGER_JWT)
    initWithAdmin()

    await call('tenko-monitor' as never)

    expect(managerGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url, bearer: `Bearer ${ADMIN_JWT}` })
  })

  it.each(CSVS)('★ %s: 席の鍵が取れない → 理由を投げて送らない', async (_n, _url, call) => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(call('tenko-monitor' as never)).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('打刻 CSV: 席の鍵が dev + admin JWT あり → alc-app の route へ席の鍵の Bearer で送る', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    initWithAdmin()

    await downloadTimePunchesCsv({ employee_id: 'e1' }, 'tenko-monitor')

    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent()).toEqual({ url: '/api/timecard/punches/csv?employee_id=e1', bearer: `Bearer ${DEV_MANAGER_JWT}` })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('打刻 CSV: 席の鍵が取れない → 理由を投げて送らない', async () => {
    noteDeviceToken('manager-device', DEV_MANAGER_JWT)
    managerGetter.mockResolvedValue(null)
    initWithAdmin()

    await expect(downloadTimePunchesCsv({}, 'tenko-monitor')).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('打刻 CSV: scope なし + 認証情報なし → 従来の直叩き (proxy 経由の CSV)', async () => {
    initApi(API_BASE, undefined, () => 'test-tenant')

    await downloadTimePunchesCsv({})

    expect(sent().url).toBe(`${API_BASE}/api/timecard/punches/csv`)
  })
})
