// 自己点検表の不足を埋める API の口 (設定 / 車両番号 / 故障の履歴 / キオスクからの故障記録)。
// 新しい口は実サーバにまだ無いことがあるので、api.test.ts (live でも走る) とは分けて fetch を差し替える。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi, getTenkoSettings, updateTenkoSettings, updateTenkoSessionVehicle,
  getEquipmentFailureHistory, reportEquipmentFailure, createFailure,
  resumeTenkoSession, selfResumeTenkoSession, cancelTenkoSession, submitManagerJudgment,
  createSchedule, updateSchedule, batchCreateSchedules,
} from '~/utils/api'

const API_BASE = 'https://api.example.test'
let fetchMock: ReturnType<typeof vi.fn>
let managerGetter: ReturnType<typeof vi.fn>
let kioskGetter: ReturnType<typeof vi.fn>

function okJson(body: unknown = {}) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body }
}
const bearerOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('Authorization')
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string)
const urlOf = (call: unknown[]) => call[0] as string
const methodOf = (call: unknown[]) => (call[1] as RequestInit).method

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson())
  vi.stubGlobal('fetch', fetchMock)
  managerGetter = vi.fn(async () => 'manager.jwt' as string | null)
  kioskGetter = vi.fn(async () => 'kiosk.jwt' as string | null)
  initApi(API_BASE, undefined, () => 'test-tenant', undefined, kioskGetter, managerGetter)
})
afterEach(() => vi.unstubAllGlobals())

const SID = '11111111-1111-4111-8111-111111111111'

describe('設定 (予定超過の分数)', () => {
  it('getTenkoSettings は運行管理者席の鍵で GET /tenko/settings', async () => {
    fetchMock.mockResolvedValue(okJson({ overdue_minutes: 60 }))
    expect(await getTenkoSettings()).toEqual({ overdue_minutes: 60 })
    const c = fetchMock.mock.calls[0]!
    expect(urlOf(c)).toContain('/api/proxy/tenko/settings')
    expect(bearerOf(c)).toBe('Bearer manager.jwt')
    expect(kioskGetter).not.toHaveBeenCalled()
  })
  it('updateTenkoSettings は PUT で overdue_minutes を送る', async () => {
    fetchMock.mockResolvedValue(okJson({ overdue_minutes: 90 }))
    await updateTenkoSettings({ overdue_minutes: 90 })
    const c = fetchMock.mock.calls[0]!
    expect(methodOf(c)).toBe('PUT')
    expect(urlOf(c)).toContain('/api/proxy/tenko/settings')
    expect(bodyOf(c)).toEqual({ overdue_minutes: 90 })
    expect(bearerOf(c)).toBe('Bearer manager.jwt')
  })
})

describe('車両番号', () => {
  it('updateTenkoSessionVehicle は PUT /tenko/sessions/{id}/vehicle をキオスクの鍵で送る', async () => {
    await updateTenkoSessionVehicle(SID, { carins_cert_no: '123', vehicle_number: '1-2' })
    const c = fetchMock.mock.calls[0]!
    expect(methodOf(c)).toBe('PUT')
    expect(urlOf(c)).toContain(`/api/proxy/tenko/sessions/${SID}/vehicle`)
    expect(bodyOf(c)).toEqual({ carins_cert_no: '123', vehicle_number: '1-2' })
    expect(bearerOf(c)).toBe('Bearer kiosk.jwt')
    expect(managerGetter).not.toHaveBeenCalled()
  })
  it('scope を渡せば管理画面の鍵でも送れる', async () => {
    await updateTenkoSessionVehicle(SID, { vehicle_number: 'x' }, 'manager-device')
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBe('Bearer manager.jwt')
  })
  it('予定の作成・更新・一括は vehicle_number をそのまま送る', async () => {
    const body = { employee_id: SID, tenko_type: 'pre_operation', responsible_manager_name: 'a', scheduled_at: '2026-01-01T00:00:00Z', vehicle_number: 'V1' } as never
    await createSchedule(body)
    await updateSchedule(SID, { vehicle_number: 'V2' })
    await batchCreateSchedules([body])
    expect(bodyOf(fetchMock.mock.calls[0]!).vehicle_number).toBe('V1')
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ vehicle_number: 'V2' })
    expect(bodyOf(fetchMock.mock.calls[2]!).schedules[0].vehicle_number).toBe('V1')
  })
})

describe('再開・中止・判定の本文', () => {
  it('resume / self-resume は resumed_by_name、cancel / judgment は alternative_measure を運ぶ', async () => {
    await resumeTenkoSession(SID, { reason: 'r', resumed_by_name: '鈴木' }, 'tenko-monitor')
    await selfResumeTenkoSession(SID, { reason: 'r', resumed_by_name: '鈴木' })
    await cancelTenkoSession(SID, { reason: 'r', alternative_measure: '代替' })
    await submitManagerJudgment(SID, { judgment: 'ng', judged_by_employee_id: SID, alternative_measure: '代替' })
    expect(bodyOf(fetchMock.mock.calls[0]!).resumed_by_name).toBe('鈴木')
    expect(bodyOf(fetchMock.mock.calls[1]!).resumed_by_name).toBe('鈴木')
    expect(bodyOf(fetchMock.mock.calls[2]!).alternative_measure).toBe('代替')
    expect(bodyOf(fetchMock.mock.calls[3]!).alternative_measure).toBe('代替')
  })
})

describe('故障の記録と履歴', () => {
  it('getEquipmentFailureHistory は GET /tenko/equipment-failures/{id}/history', async () => {
    fetchMock.mockResolvedValue(okJson([{ changed_at: 't', old_row: {} }]))
    const r = await getEquipmentFailureHistory(SID, 'default')
    expect(r).toHaveLength(1)
    expect(urlOf(fetchMock.mock.calls[0]!)).toContain(`/api/proxy/tenko/equipment-failures/${SID}/history`)
  })
  it('reportEquipmentFailure はキオスクの鍵で POST する (createFailure と同じ口)', async () => {
    await reportEquipmentFailure({ failure_type: 'kiosk_offline', description: '通信失敗' })
    await createFailure({ failure_type: 'manual_report', description: 'x' })
    const c = fetchMock.mock.calls[0]!
    expect(methodOf(c)).toBe('POST')
    expect(urlOf(c)).toContain('/api/proxy/tenko/equipment-failures')
    expect(bearerOf(c)).toBe('Bearer kiosk.jwt')
    expect(bodyOf(c)).toEqual({ failure_type: 'kiosk_offline', description: '通信失敗' })
    expect(urlOf(fetchMock.mock.calls[1]!)).toBe(urlOf(c))
  })
})
