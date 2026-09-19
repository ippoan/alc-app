// api.ts の**トークンの選び方** — 血圧測定台 (Refs ippoan/alc-app#353)。
//
// 測定台は `devices` に行を持たず `deviceId` が構造的に空なので、admin browser JWT も
// キオスクの device JWT も持たない。auth-worker の `BP_STATION_ROUTES` が role
// `device-bp-station` に許した 4 本を、測定台の鍵 (ATOM S3) で通す。ここで固定するのは 3 つ:
//
//   1. **4 本すべて**が測定台トークンで通る (1 本でも漏れると無認証の X-Tenant-ID 直 fetch に落ちる)
//   2. トークンが取れなければ**投げる** (fail-closed。キオスクの鍵にも無認証 fetch にも落とさない)
//   3. **測定台の getter を渡していない端末 (= 通常のキオスク) は 1 ミリも変わらない**
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi,
  BP_STATION_DEVICE_AUTH_FAILED_MESSAGE,
  getEmployeeByNfcId, getFaceData, startMeasurement, updateMeasurement,
  getEmployees, startTenkoSession, submitAlcohol, listSchedules,
} from '~/utils/api'

const API_BASE = 'https://api.example.test'
const BP_JWT = 'bp-station.jwt'
const KIOSK_JWT = 'kiosk.jwt'
const MANAGER_JWT = 'manager.jwt'
const ADMIN_JWT = 'admin.jwt'

let fetchMock: ReturnType<typeof vi.fn>
let bpGetter: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>
let managerGetter: ReturnType<typeof vi.fn>

/** 中身は見ないので 200 + 空 JSON を返す。 */
function okJson(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

/** 直近の fetch に載った Authorization ヘッダーを返す。 */
function bearerOf(call: unknown[]): string | null {
  const init = call[1] as RequestInit | undefined
  return new Headers(init?.headers).get('Authorization')
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson())
  vi.stubGlobal('fetch', fetchMock)
  bpGetter = vi.fn(async () => BP_JWT as string | null)
  kioskGetter = vi.fn(async () => KIOSK_JWT as string | null)
  managerGetter = vi.fn(async () => MANAGER_JWT as string | null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** admin JWT 無し + 3 つの getter (= 本番の測定台と同じ状態)。 */
function initBpStation() {
  initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter, bpGetter)
}

/** auth-worker の `BP_STATION_ROUTES` に対応する 4 本。**1 本も漏らさない**。 */
const BP_STATION_CALLS: [string, () => Promise<unknown>][] = [
  ['getEmployeeByNfcId (POST /api/employees/lookup)', () => getEmployeeByNfcId('1234567890123456')],
  ['getFaceData (GET /api/employees/face-data)', () => getFaceData()],
  ['startMeasurement (POST /api/measurements/start)', () => startMeasurement('emp-1')],
  ['updateMeasurement (PUT /api/measurements/{id})', () => updateMeasurement('m-1', { status: 'completed' })],
]

describe('api.ts — 測定台の 4 本は測定台の鍵で通す (#353)', () => {
  it.each(BP_STATION_CALLS)('%s は測定台トークンで proxy 経由に載る', async (_name, call) => {
    initBpStation()
    await call()

    expect(bpGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(managerGetter).not.toHaveBeenCalled()
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/api/proxy/')
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${BP_JWT}`)
  })

  it('4 本とも通る = 無認証の X-Tenant-ID 直 fetch に落ちた口が 1 つも無い', async () => {
    initBpStation()
    for (const [, call] of BP_STATION_CALLS) await call()

    expect(bpGetter).toHaveBeenCalledTimes(BP_STATION_CALLS.length)
    for (const call of fetchMock.mock.calls) {
      expect(bearerOf(call)).toBe(`Bearer ${BP_JWT}`)
      expect(new Headers((call[1] as RequestInit | undefined)?.headers).get('X-Tenant-ID')).toBeNull()
    }
  })

  it.each(BP_STATION_CALLS)(
    '%s は測定台トークンが取れなければ**投げる** (fail-closed。無認証経路に落とさない)',
    async (_name, call) => {
      bpGetter.mockResolvedValue(null)
      initBpStation()

      await expect(call()).rejects.toThrow(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
      // 撃っていない = 無認証でサーバに行っていない
      expect(fetchMock).not.toHaveBeenCalled()
      expect(kioskGetter).not.toHaveBeenCalled()
    },
  )

  it('ATOM S3 が無い測定台でも、403 でも素の TypeError でもなく次の手が打てる文言が出る', async () => {
    // useBpStationDeviceToken は ATOM S3 が居なければ**通信もせずに** null を返す
    // (stage=no-bp-station)。その状態をそのまま再現する。
    bpGetter.mockResolvedValue(null)
    initBpStation()

    const err = await getEmployeeByNfcId('1234567890123456').catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(
      '血圧測定台の端末で認証できませんでした。この測定台の ATOM S3 が USB でつながっていて、'
      + '用途「測定台」で鍵が登録されているか確認してください',
    )
    expect((err as Error).message).not.toContain('403')
    expect((err as Error).message).not.toContain('forbidden')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('文言は原因の見当がつく形で出す (ATOM S3 / 用途「測定台」)', () => {
    expect(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE).toContain('血圧測定台の端末で認証できませんでした')
    expect(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE).toContain('ATOM S3')
    expect(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE).toContain('測定台')
  })

  it('admin JWT があるときは従来どおり admin が優先 (admin タブは無変更)', async () => {
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter, managerGetter, bpGetter)
    await startMeasurement('emp-1')

    expect(bpGetter).not.toHaveBeenCalled()
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${ADMIN_JWT}`)
  })
})

describe('api.ts — 測定台の getter を渡さない端末は無変更 (#353)', () => {
  it.each(BP_STATION_CALLS)('%s は従来どおりキオスクの鍵で通る', async (_name, call) => {
    initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter)
    await call()

    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${KIOSK_JWT}`)
  })

  it('測定台の鍵が取れない端末でも、点呼と予定の口は 1 つも巻き添えにならない', async () => {
    bpGetter.mockResolvedValue(null)
    initBpStation()

    // 測定台の口だけが止まる
    await expect(startMeasurement('emp-1')).rejects.toThrow(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
    // 点呼はキオスクの鍵、予定は運行管理者の鍵で今までどおり通る
    await expect(getEmployees()).resolves.toBeDefined()
    await expect(startTenkoSession({ employee_id: 'e1', tenko_type: 'pre_operation' } as never)).resolves.toBeDefined()
    await expect(submitAlcohol('s1', {} as never)).resolves.toBeDefined()
    await expect(listSchedules()).resolves.toBeDefined()
    expect(bearerOf(fetchMock.mock.calls.at(-1)!)).toBe(`Bearer ${MANAGER_JWT}`)
    expect(bpGetter).toHaveBeenCalledTimes(1) // 点呼・予定では 1 度も呼ばれていない
  })
})
