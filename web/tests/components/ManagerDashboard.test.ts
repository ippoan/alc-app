import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerDashboard from '~/components/ManagerDashboard.vue'
import { noteDeviceToken } from '~/utils/token-selection'
import { devDeviceJwt } from '../helpers/dummy-jwt'

// 「点呼」と「点呼記録」のタブを 1 つにまとめる (Refs #238, ippoan/alc-app-s3#135)。
// 既定タブ ('tenko') が使う TenkoDashboardSummary / TenkoSessionMonitor が呼ぶ分だけ mock する。

vi.mock('~/utils/api', () => ({
  getTenkoDashboard: vi.fn(async () => ({
    pending_schedules: 0, active_sessions: 0, interrupted_sessions: 0,
    completed_today: 0, cancelled_today: 0, overdue_schedules: [],
  })),
  getEmployees: vi.fn(async () => []),
  listTenkoSessions: vi.fn(async () => ({ sessions: [], total: 0, page: 1, per_page: 20 })),
  downloadTenkoRecordsCsv: vi.fn(async () => {}),
  interruptTenkoSession: vi.fn(),
  resumeTenkoSession: vi.fn(),
  cancelTenkoSession: vi.fn(),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ManagerDashboard — 点呼記録タブの廃止', () => {
  beforeEach(() => vi.clearAllMocks())

  it('「点呼記録」のタブが無い', async () => {
    const wrapper = await mountSuspended(ManagerDashboard)
    await flush()
    await wrapper.vm.$nextTick()
    const tabLabels = wrapper.findAll('button').map(b => b.text())
    expect(tabLabels).not.toContain('点呼記録')
    expect(wrapper.text()).not.toContain('点呼記録')
    wrapper.unmount()
  })

  it('「測定履歴」のタブが無い (点呼タブに統合、Refs ippoan/alc-app-s3#135)', async () => {
    const wrapper = await mountSuspended(ManagerDashboard)
    await flush()
    await wrapper.vm.$nextTick()
    const tabLabels = wrapper.findAll('button').map(b => b.text())
    expect(tabLabels).not.toContain('測定履歴')
    wrapper.unmount()
  })
})

// IT点呼 の受け画面 (`TenkoItAdminView`) は、ここのタブから画面最上段の役割タブ (`pages/index.vue`) へ
// 移した (Refs ippoan/alc-app#387)。入口を 2 つにしないよう、開発用の印がある席でもここには出さない。
// 役割タブの側のテストは `tests/pages/index.test.ts`
describe('ManagerDashboard — IT点呼 の受け画面はここには無い (最上段の役割タブへ移した)', () => {
  const ItViewStub = { name: 'TenkoItAdminView', template: '<div data-testid="it-admin-view" />' }
  const stubs = { TenkoItAdminView: ItViewStub }
  // ラベルでは絞らずに、タブ列 (`bg-blue-100` の帯) のボタンを全部集める
  const allTabLabels = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) =>
    wrapper.findAll('div.bg-blue-100 > button').map(b => b.text())

  beforeEach(() => {
    vi.clearAllMocks()
    noteDeviceToken('manager-device', null)
    noteDeviceToken('kiosk', null)
    localStorage.clear()
  })

  it.each([
    ['印なし', false],
    ['印あり', true],
  ])('★ %s: タブに「IT点呼」が無く、TenkoItAdminView は描画されない', async (_name, marked) => {
    if (marked) noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountSuspended(ManagerDashboard, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()
    expect(allTabLabels(wrapper)).not.toContain('IT点呼')
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)
    // 既定のタブ (点呼) の描画は今までどおり
    expect(wrapper.text()).toContain('進行中セッション')
    wrapper.unmount()
  })

  it('印ありの席に initialTab="it_tenko" が渡っても TenkoItAdminView は描画されない', async () => {
    noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountSuspended(ManagerDashboard, { props: { initialTab: 'it_tenko' }, global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// IT点呼 の試験の手順書のタブ (Refs ippoan/alc-app#387)。**開発用の印の有無に関係なく常に**、最後に出す。
// ラベルで絞って集めると、新しいタブを足しても緑のまま (= 検知しない)。
// ここでは絞らずに全部のタブのボタンを集めて、並びを完全一致で固定する
describe('ManagerDashboard — IT点呼 試験の手順タブ (常に最後)', () => {
  const TABS_BEFORE = [
    '乗務員', '免許証', '点呼', '遠隔点呼', '画面共有', '予定管理',
    '健康基準', '故障記録', '携行品', '労働時間', 'タイムカード', 'デバイス管理',
  ]
  const GUIDE_LABEL = 'IT点呼 試験の手順'
  const GuideStub = { name: 'ItTenkoGuide', template: '<div data-testid="it-guide" />' }
  const stubs = {
    ItTenkoGuide: GuideStub,
    TenkoItAdminView: { template: '<div data-testid="it-admin-view" />' },
  }

  async function mountDashboard() {
    const wrapper = await mountSuspended(ManagerDashboard, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()
    return wrapper
  }
  // ラベルでは絞らずに、タブ列 (`bg-blue-100` の帯) のボタンを全部集める。
  // 帯の外のボタン (既定の「点呼」タブの中身など) は数えない
  const allTabLabels = (wrapper: Awaited<ReturnType<typeof mountDashboard>>) =>
    wrapper.findAll('div.bg-blue-100 > button').map(b => b.text())

  beforeEach(() => {
    vi.clearAllMocks()
    noteDeviceToken('manager-device', null)
    noteDeviceToken('kiosk', null)
    localStorage.clear()
  })

  // 開発用の印が在っても並びは同じ (IT点呼 の受け画面は最上段の役割タブへ移した)
  it.each([
    ['印なし', false],
    ['印あり', true],
  ])('★ %s: 全部のタブは既存の 12 個のあとに「IT点呼 試験の手順」が 1 つ (計 13、IT点呼 は無い)', async (_name, marked) => {
    if (marked) noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountDashboard()
    expect(allTabLabels(wrapper)).toEqual([...TABS_BEFORE, GUIDE_LABEL])
    wrapper.unmount()
  })

  it.each([
    ['印なし', false],
    ['印あり', true],
  ])('%s: 押すと ItTenkoGuide が描画される (既定のタブでは描画されない)', async (_name, marked) => {
    if (marked) noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountDashboard()
    expect(wrapper.find('[data-testid="it-guide"]').exists()).toBe(false)

    await wrapper.findAll('button').find(b => b.text() === GUIDE_LABEL)!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="it-guide"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('別のタブへ移ると ItTenkoGuide は消える', async () => {
    const wrapper = await mountDashboard()
    await wrapper.findAll('button').find(b => b.text() === GUIDE_LABEL)!.trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('button').find(b => b.text() === '点呼')!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="it-guide"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
