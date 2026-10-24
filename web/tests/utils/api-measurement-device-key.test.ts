// api.ts — 測定を作る・更新する 4 口は、端末の鍵の JWT が取れればそちらで送る
// (Refs ippoan/alc-cam#2、設計書 §5.5)。管理者ログインが残った PC でも auth-worker が
// 検証済みの token の sub から X-Device-Id を付けられるようにするため。固定するのは:
//   1. 管理者 JWT + 端末の鍵の両方がある → 4 口は端末の鍵で /api/proxy へ (測定台なら測定台の鍵)
//   2. 端末の鍵が取れない (null / 投げる / getter 無し) → 今までどおり管理者の経路
//   3. 端末の鍵が 401/403 で拒まれた → 管理者の経路でやり直す (測定を止めない)。それ以外の失敗は投げる
//   4. 測定以外の口は管理者のまま (端末の getter も呼ばない)
//   5. dev 端末の規則 (管理者へ戻さない) は変わらない
//   6. ブラウザが端末 ID を名乗る形 (ヘッダー・本文) にはしない
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi, setBpStationJwtGetter,
  startMeasurement, saveMeasurement, updateMeasurement, confirmMeasurementTenko,
  getMeasurements, getEmployees, getDeviceKeyStatus,
} from '~/utils/api'
import { noteDeviceToken, type DeviceTokenKind } from '~/utils/token-selection'
import { browserJwt, devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const API_BASE = 'https://api.example.test'
const ADMIN_JWT = browserJwt()
const KIOSK_JWT = plainDeviceJwt('alarm:kiosk')
const BP_JWT = plainDeviceJwt('alarm:bp')
const DEV_KIOSK_JWT = devDeviceJwt('alarm:dev-kiosk')
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

let fetchMock: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>
let bpGetter: ReturnType<typeof vi.fn>

const okJson = (body: unknown = {}) => ({
  ok: true, status: 200, statusText: 'OK',
  text: async () => JSON.stringify(body), json: async () => body,
})
const failed = (status: number) => ({
  ok: false, status, statusText: 'x',
  text: async () => 'denied', json: async () => ({}),
})

function sent(n = 0) {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined]
  const h = new Headers(init?.headers)
  return { url, bearer: h.get('Authorization'), tenant: h.get('X-Tenant-ID'), deviceId: h.get('X-Device-Id'), body: init?.body }
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson())
  vi.stubGlobal('fetch', fetchMock)
  kioskGetter = vi.fn(async () => KIOSK_JWT as string | null)
  bpGetter = vi.fn(async () => BP_JWT as string | null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  setBpStationJwtGetter(null)
  for (const kind of KINDS) noteDeviceToken(kind, null)
  localStorage.clear()
})

function init(opts: { bp?: boolean, kiosk?: boolean } = {}) {
  initApi(
    API_BASE, () => ADMIN_JWT, () => 'test-tenant', undefined,
    opts.kiosk === false ? undefined : kioskGetter, undefined, opts.bp ? bpGetter : undefined,
  )
}

const RESULT = {
  employeeId: 'e1', alcoholValue: 0, resultType: 'normal', deviceUseCount: 1,
  measuredAt: new Date('2026-10-24T00:00:00Z'),
} as unknown as Parameters<typeof saveMeasurement>[0]

/** 4 口 (キオスク = 土台 default の口 / 測定台の口) */
const KIOSK_CALLS: [string, () => Promise<unknown>, string][] = [
  ['saveMeasurement', () => saveMeasurement(RESULT), '/api/proxy/measurements'],
  ['startMeasurement', () => startMeasurement('e1'), '/api/proxy/measurements/start'],
  ['updateMeasurement', () => updateMeasurement('m1', { status: 'completed' }), '/api/proxy/measurements/m1'],
  ['confirmMeasurementTenko', () => confirmMeasurementTenko('m1', '通常点呼'), '/api/proxy/measurements/m1/tenko'],
]

describe('測定の 4 口 — 端末の鍵が取れればそちらで送る', () => {
  it.each(KIOSK_CALLS)('%s: 管理者 JWT があってもキオスクの鍵で proxy へ', async (_n, call, path) => {
    init()
    await call()
    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const s = sent()
    expect(s.url).toBe(path)
    expect(s.bearer).toBe(`Bearer ${KIOSK_JWT}`)
    // ブラウザは端末 ID を名乗らない
    expect(s.deviceId).toBeNull()
  })

  it.each(KIOSK_CALLS.slice(1))('%s: 測定台と決着した画面なら測定台の鍵で送る (キオスクの getter は呼ばない)', async (_n, call, path) => {
    init({ bp: true })
    await call()
    expect(bpGetter).toHaveBeenCalledTimes(1)
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(sent().url).toBe(path)
    expect(sent().bearer).toBe(`Bearer ${BP_JWT}`)
  })

  it('saveMeasurement は測定台の getter があってもキオスクの鍵 (土台は default)', async () => {
    init({ bp: true })
    await saveMeasurement(RESULT)
    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(bpGetter).not.toHaveBeenCalled()
  })

  it('本文に端末 ID を足さない', async () => {
    init()
    await startMeasurement('e1')
    expect(JSON.parse(sent().body as string)).toEqual({ employee_id: 'e1' })
  })
})

describe('測定の 4 口 — 端末の鍵が取れなければ今までどおり管理者の経路', () => {
  it.each(KIOSK_CALLS)('%s: 鍵が null → 管理者の経路 (X-Tenant-ID は付かず Bearer は管理者)', async (_n, call, path) => {
    kioskGetter.mockResolvedValue(null)
    init()
    await call()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().url).toBe(path)
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('鍵の取得が投げても管理者の経路で送る (測定を止めない)', async () => {
    kioskGetter.mockRejectedValue(new Error('usb'))
    init()
    await startMeasurement('e1')
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('キオスクの getter が無い環境は管理者の経路', async () => {
    init({ kiosk: false })
    await startMeasurement('e1')
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })

  it('測定台の getter があって鍵が取れなければ、管理者の経路 (投げない)', async () => {
    bpGetter.mockResolvedValue(null)
    init({ bp: true })
    await updateMeasurement('m1', {})
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
    expect(kioskGetter).not.toHaveBeenCalled()
  })

  it('端末の鍵が 401 / 403 で拒まれたら、管理者の経路でやり直す', async () => {
    fetchMock.mockResolvedValueOnce(failed(403)).mockResolvedValueOnce(okJson())
    init()
    await startMeasurement('e1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent(0).bearer).toBe(`Bearer ${KIOSK_JWT}`)
    expect(sent(1).bearer).toBe(`Bearer ${ADMIN_JWT}`)

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(failed(401)).mockResolvedValueOnce(okJson())
    await startMeasurement('e1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('それ以外の失敗 (409 など) は管理者でやり直さず投げる', async () => {
    fetchMock.mockResolvedValueOnce(failed(409))
    init()
    await expect(startMeasurement('e1')).rejects.toMatchObject({ status: 409 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('測定以外の口は管理者のまま', () => {
  it('getMeasurements・getEmployees は管理者の経路で、端末の getter を呼ばない', async () => {
    init({ bp: true })
    await getMeasurements()
    await getEmployees()
    expect(kioskGetter).not.toHaveBeenCalled()
    expect(bpGetter).not.toHaveBeenCalled()
    expect(sent(0).bearer).toBe(`Bearer ${ADMIN_JWT}`)
    expect(sent(1).bearer).toBe(`Bearer ${ADMIN_JWT}`)
  })
})

describe('dev 端末の規則は変わらない', () => {
  it('dev のキオスク + 管理者 JWT → 端末の鍵で 1 回だけ送る', async () => {
    kioskGetter.mockResolvedValue(DEV_KIOSK_JWT)
    init()
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    await startMeasurement('e1')
    expect(kioskGetter).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().bearer).toBe(`Bearer ${DEV_KIOSK_JWT}`)
  })

  it('dev のキオスクで鍵が取れなくても管理者の Bearer へ戻さない', async () => {
    kioskGetter.mockResolvedValue(null)
    init()
    noteDeviceToken('kiosk', DEV_KIOSK_JWT)
    await startMeasurement('e1')
    expect(sent().bearer).not.toBe(`Bearer ${ADMIN_JWT}`)
  })
})

describe('getDeviceKeyStatus — 管理画面の口', () => {
  it('/api/cam-clips/device-key-status?days=N を管理者の経路で呼ぶ', async () => {
    init()
    fetchMock.mockResolvedValue(okJson({ days: 30, devices: [], unattributed: { measurements: 0, last_at: null } }))
    const res = await getDeviceKeyStatus(30)
    expect(res.days).toBe(30)
    expect(sent().url).toBe('/api/proxy/cam-clips/device-key-status?days=30')
    expect(sent().bearer).toBe(`Bearer ${ADMIN_JWT}`)
    expect(kioskGetter).not.toHaveBeenCalled()
  })

  it('days の既定は 7', async () => {
    init()
    await getDeviceKeyStatus()
    expect(sent().url).toBe('/api/proxy/cam-clips/device-key-status?days=7')
  })
})
