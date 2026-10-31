// 運行管理者席の読み取り: ManagerDashboard の各タブが読み取りに scope 'tenko-monitor' を付けること。
// 席の鍵が dev のときだけ席の鍵で送られ、admin PC では 'default' と同じ経路 (api 側のテスト参照)。
// 書き込みは scope を付けない (管理者ログイン)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'

const m = vi.hoisted(() => ({
  getEmployees: vi.fn(async () => [{ id: 'e1', name: '山田' }]),
  getTenkoDashboard: vi.fn(async () => ({ pending_schedules: [], active_sessions: [], overdue_schedules: [], interrupted_sessions: [], today_completed: 0 })),
  listBaselines: vi.fn(async () => []),
  listFailures: vi.fn(async () => ({ failures: [], total: 0, page: 1, per_page: 20 })),
  downloadFailuresCsv: vi.fn(async () => {}),
  getCarryingItems: vi.fn(async () => []),
  getVehicleCategories: vi.fn(async () => ({ car_kinds: [], uses: [], car_shapes: [], private_businesses: [] })),
  getDtakoDrivers: vi.fn(async () => [{ id: 'd1', driver_name: '運転者' }]),
  getDtakoDailyHours: vi.fn(async () => ({ items: [], total: 0 })),
  listTimecardCards: vi.fn(async () => []),
  listTimePunches: vi.fn(async () => ({ punches: [], total: 0 })),
  downloadTimePunchesCsv: vi.fn(async () => {}),
  listDevices: vi.fn(async () => []),
  listPendingDeviceRegistrations: vi.fn(async () => []),
}))

vi.mock('~/utils/api', async (orig) => ({ ...(await orig<object>()), ...m }))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const MON = 'tenko-monitor'

describe('運行管理者席の読み取りは scope tenko-monitor で呼ぶ', () => {
  beforeEach(() => vi.clearAllMocks())

  it('LicenseRegistration: 乗務員一覧', async () => {
    const { default: C } = await import('~/components/LicenseRegistration.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getEmployees).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('TenkoDashboardSummary: ダッシュボードと乗務員一覧', async () => {
    const { default: C } = await import('~/components/TenkoDashboardSummary.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getEmployees).toHaveBeenCalledWith(MON)
    expect(m.getTenkoDashboard).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('TenkoScheduleManager: 乗務員一覧', async () => {
    const { default: C } = await import('~/components/TenkoScheduleManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getEmployees).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('HealthBaselineManager: 乗務員一覧とベースライン一覧', async () => {
    const { default: C } = await import('~/components/HealthBaselineManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getEmployees).toHaveBeenCalledWith(MON)
    expect(m.listBaselines).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('EquipmentFailureManager: 一覧と CSV', async () => {
    const { default: C } = await import('~/components/EquipmentFailureManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.listFailures).toHaveBeenCalledWith(expect.anything(), MON)
    const csv = w.findAll('button').find(b => b.text().includes('CSV'))!
    await csv.trigger('click')
    await flush()
    expect(m.downloadFailuresCsv).toHaveBeenCalledWith(expect.anything(), MON)
    w.unmount()
  })

  it('CarryingItemsManager: 携行品と車両分類', async () => {
    const { default: C } = await import('~/components/CarryingItemsManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getCarryingItems).toHaveBeenCalledWith(MON)
    expect(m.getVehicleCategories).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('WorkHoursViewer: ドライバーと日次労働時間', async () => {
    const { default: C } = await import('~/components/WorkHoursViewer.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getDtakoDrivers).toHaveBeenCalledWith(MON)
    expect(m.getDtakoDailyHours).toHaveBeenCalledWith(expect.anything(), MON)
    w.unmount()
  })

  it('DeviceRegistrationManager: 端末と承認待ち', async () => {
    const { default: C } = await import('~/components/DeviceRegistrationManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.listDevices).toHaveBeenCalledWith(MON)
    expect(m.listPendingDeviceRegistrations).toHaveBeenCalledWith(MON)
    w.unmount()
  })

  it('TimecardManager: 乗務員・カード・打刻・CSV', async () => {
    const { default: C } = await import('~/components/TimecardManager.vue')
    const w = await mountSuspended(C)
    await flush()
    expect(m.getEmployees).toHaveBeenCalledWith(MON)
    expect(m.listTimecardCards).toHaveBeenCalledWith(undefined, MON)
    const vm = w.vm as unknown as { exportCsv?: () => Promise<void>, loadPunches?: () => Promise<void> }
    await vm.loadPunches!()
    expect(m.listTimePunches).toHaveBeenCalledWith(expect.anything(), MON)
    await vm.exportCsv!()
    expect(m.downloadTimePunchesCsv).toHaveBeenCalledWith(expect.anything(), MON)
    w.unmount()
  })
})
