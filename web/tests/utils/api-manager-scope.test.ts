// api.ts の**トークンの選び方** (Refs ippoan/alc-app#337)。
//
// 運行管理者タブは admin browser JWT を持たない (NFC + 顔認証で入る) ので、予定の口は
// 運行管理者席 (VoiceS3R) の鍵で通す。ここで固定するのは 2 つ:
//
//   1. 予定 CRUD 6 本は運行管理者トークンで通る (取れなければ**無言で 403 にせず**理由を投げる)
//   2. **キオスクの点呼は運行管理者トークンを一切使わない** (`getPendingSchedules` を含む)
//
// 既存の api.test.ts は initApi に運行管理者 getter を渡さない = 従来の優先順位のままで、
// こちらは getter を渡した状態だけを見る (両方が同じファイルに居ると前提が混ざるので分けた)。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi,
  MANAGER_DEVICE_AUTH_FAILED_MESSAGE,
  createSchedule, batchCreateSchedules, listSchedules, getSchedule, updateSchedule, deleteSchedule,
  getPendingSchedules,
  startTenkoSession, submitAlcohol, getTenkoDashboard, getEmployees,
} from '~/utils/api'

const API_BASE = 'https://api.example.test'
const MANAGER_JWT = 'manager.jwt'
const KIOSK_JWT = 'kiosk.jwt'
const ADMIN_JWT = 'admin.jwt'

let fetchMock: ReturnType<typeof vi.fn>
let managerGetter: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>

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
  managerGetter = vi.fn(async () => MANAGER_JWT as string | null)
  kioskGetter = vi.fn(async () => KIOSK_JWT as string | null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** admin JWT 無し + キオスク getter + 運行管理者 getter (= 本番の運行管理者席と同じ状態)。 */
function initManagerSeat() {
  initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter)
}

describe('api.ts — 予定の口は運行管理者席の鍵で通す (#337)', () => {
  it('listSchedules は運行管理者トークンで proxy 経由に載る (キオスクの鍵は使わない)', async () => {
    initManagerSeat()
    await listSchedules({ page: 1 })

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/api/proxy/tenko/schedules')
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${MANAGER_JWT}`)
  })

  it.each([
    ['createSchedule', () => createSchedule({ employee_id: 'e1', tenko_type: 'pre_operation', scheduled_at: '2026-01-01T00:00:00Z' } as never)],
    ['batchCreateSchedules', () => batchCreateSchedules([])],
    ['getSchedule', () => getSchedule('s1')],
    ['updateSchedule', () => updateSchedule('s1', {} as never)],
    ['deleteSchedule', () => deleteSchedule('s1')],
  ])('%s も運行管理者トークンで通る', async (_name, call) => {
    initManagerSeat()
    await call()

    expect(managerGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${MANAGER_JWT}`)
  })

  it('運行管理者トークンが取れなければ**キオスクの鍵に落とさず**理由を投げる (無言の 403 にしない)', async () => {
    managerGetter.mockResolvedValue(null)
    initManagerSeat()

    await expect(listSchedules()).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    // 撃っていない = サーバに 403 を貰いに行っていない
    expect(fetchMock).not.toHaveBeenCalled()
    expect(kioskGetter).not.toHaveBeenCalled()
  })

  it('VoiceS3R が無い端末で予定管理を開いても 403 にはならず、何をすればよいかが出る', async () => {
    // useManagerDeviceToken は VoiceS3R 未接続なら**通信もせずに** null を返す
    // (stage=no-alarm-device)。その状態をそのまま再現する。
    managerGetter.mockResolvedValue(null)
    initManagerSeat()

    const err = await listSchedules().catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    // 利用者が読んで次の手が打てる文言であること (403 forbidden でも素の TypeError でもない)
    expect((err as Error).message).toBe(
      '運行管理者席の端末で認証できませんでした。この席の警告デバイス (VoiceS3R) が USB でつながっていて、'
      + '用途「運行管理者席」で鍵が登録されているか確認してください',
    )
    expect((err as Error).message).not.toContain('403')
    expect((err as Error).message).not.toContain('forbidden')
    // サーバに 403 を貰いに行ってもいない
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('文言は原因の見当がつく形で出す (VoiceS3R / 用途「運行管理者席」)', () => {
    expect(MANAGER_DEVICE_AUTH_FAILED_MESSAGE).toContain('運行管理者席の端末で認証できませんでした')
    expect(MANAGER_DEVICE_AUTH_FAILED_MESSAGE).toContain('VoiceS3R')
    expect(MANAGER_DEVICE_AUTH_FAILED_MESSAGE).toContain('運行管理者席')
  })

  it('admin JWT があるときは従来どおり admin が優先 (admin タブは無変更)', async () => {
    initApi(API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined, kioskGetter, managerGetter)
    await listSchedules()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('運行管理者 getter を渡していない環境は従来の優先順位のまま (キオスクの鍵へ)', async () => {
    initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter)
    await listSchedules()

    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${KIOSK_JWT}`)
  })
})

describe('api.ts — キオスクの点呼は運行管理者トークンを使わない (#337)', () => {
  it('getPendingSchedules (点呼の入口) はキオスクの鍵で通る', async () => {
    initManagerSeat()
    await getPendingSchedules('emp-1')

    expect(managerGetter).not.toHaveBeenCalled()
    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${KIOSK_JWT}`)
  })

  it.each([
    ['startTenkoSession', () => startTenkoSession({ employee_id: 'e1', tenko_type: 'pre_operation' } as never)],
    ['submitAlcohol', () => submitAlcohol('s1', {} as never)],
    ['getTenkoDashboard', () => getTenkoDashboard()],
    ['getEmployees', () => getEmployees()],
  ])('%s もキオスクの鍵のまま', async (_name, call) => {
    initManagerSeat()
    await call()

    expect(managerGetter).not.toHaveBeenCalled()
    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe(`Bearer ${KIOSK_JWT}`)
  })

  it('運行管理者席の鍵が取れない端末でも、点呼の口は 1 つも巻き添えにならない', async () => {
    managerGetter.mockResolvedValue(null)
    initManagerSeat()

    // 予定管理だけが止まる
    await expect(listSchedules()).rejects.toThrow(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    // 点呼は今までどおり通る
    await expect(getPendingSchedules('emp-1')).resolves.toBeDefined()
    await expect(startTenkoSession({ employee_id: 'e1', tenko_type: 'pre_operation' } as never)).resolves.toBeDefined()
    expect(managerGetter).toHaveBeenCalledTimes(1) // 点呼では 1 度も呼ばれていない
  })
})
