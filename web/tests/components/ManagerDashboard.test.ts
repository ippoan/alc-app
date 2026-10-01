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

// IT点呼 の受け画面のタブ (Refs ippoan/alc-app#387)。**運行管理者席の鍵に開発用の印がある席にだけ**出す。
// alc-app は main へのマージから数分で本番に出るので、印の無い席の並びをここで釘付けにする
describe('ManagerDashboard — IT点呼タブ (開発用の印がある席だけ)', () => {
  // 変更前のタブの並び (12 個)
  const TABS_BEFORE = [
    '乗務員', '免許証', '点呼', '遠隔点呼', '画面共有', '予定管理',
    '健康基準', '故障記録', '携行品', '労働時間', 'タイムカード', 'デバイス管理',
  ]
  const ItViewStub = { name: 'TenkoItAdminView', template: '<div data-testid="it-admin-view" />' }
  const stubs = {
    TenkoItAdminView: ItViewStub,
    EmployeeList: { template: '<div data-testid="employee-list" />' },
  }

  async function mountDashboard() {
    const wrapper = await mountSuspended(ManagerDashboard, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()
    return wrapper
  }
  const tabLabels = (wrapper: Awaited<ReturnType<typeof mountDashboard>>) =>
    wrapper.findAll('button').map(b => b.text()).filter(t => [...TABS_BEFORE, 'IT点呼'].includes(t))
  const clickTab = async (wrapper: Awaited<ReturnType<typeof mountDashboard>>, label: string) => {
    await wrapper.findAll('button').find(b => b.text() === label)!.trigger('click')
    await wrapper.vm.$nextTick()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    noteDeviceToken('manager-device', null)
    noteDeviceToken('kiosk', null)
    localStorage.clear()
  })

  it('★ 印なし: IT点呼 のタブが無く、タブの並びと数は変更前と同じ', async () => {
    const wrapper = await mountDashboard()
    expect(tabLabels(wrapper)).toEqual(TABS_BEFORE)
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)
    // 既定のタブ (点呼) の描画も今までどおり
    expect(wrapper.text()).toContain('進行中セッション')
    wrapper.unmount()
  })

  it('★ 印なし: タブを押しても IT点呼 は現れない (押すたびに印を読み直しても並びは同じ)', async () => {
    const wrapper = await mountDashboard()
    await clickTab(wrapper, '乗務員')
    expect(wrapper.find('[data-testid="employee-list"]').exists()).toBe(true)
    expect(tabLabels(wrapper)).toEqual(TABS_BEFORE)
    wrapper.unmount()
  })

  it('キオスクの鍵だけに印があっても出ない (見るのは運行管理者席の鍵)', async () => {
    noteDeviceToken('kiosk', devDeviceJwt('dev-kiosk'))
    const wrapper = await mountDashboard()
    expect(tabLabels(wrapper)).toEqual(TABS_BEFORE)
    wrapper.unmount()
  })

  it('印なしの席に initialTab="it_tenko" が渡っても描画せず、点呼へ戻す', async () => {
    const wrapper = await mountSuspended(ManagerDashboard, { props: { initialTab: 'it_tenko' }, global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('進行中セッション')
    wrapper.unmount()
  })

  it('印あり: 遠隔点呼の直後に出て、押すと TenkoItAdminView が描画される', async () => {
    noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountDashboard()
    const labels = tabLabels(wrapper)
    expect(labels).toHaveLength(TABS_BEFORE.length + 1)
    expect(labels[labels.indexOf('遠隔点呼') + 1]).toBe('IT点呼')
    expect(labels.filter(l => l !== 'IT点呼')).toEqual(TABS_BEFORE)
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)

    await clickTab(wrapper, 'IT点呼')
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('起動後に印が立った席でも、タブを押せば出る', async () => {
    const wrapper = await mountDashboard()
    expect(tabLabels(wrapper)).toEqual(TABS_BEFORE)
    noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    await clickTab(wrapper, '点呼')
    expect(tabLabels(wrapper)).toContain('IT点呼')
    wrapper.unmount()
  })

  it('印が外れた後にタブを押すと、IT点呼 を閉じて点呼へ戻る', async () => {
    noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountDashboard()
    await clickTab(wrapper, 'IT点呼')
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(true)

    noteDeviceToken('manager-device', null)
    // 写しは読み直すまで古いので、IT点呼 のタブはまだ押せる
    await clickTab(wrapper, 'IT点呼')
    expect(wrapper.find('[data-testid="it-admin-view"]').exists()).toBe(false)
    expect(tabLabels(wrapper)).toEqual(TABS_BEFORE)
    expect(wrapper.text()).toContain('進行中セッション')
    wrapper.unmount()
  })
})

// IT点呼 の試験の手順書のタブ (Refs ippoan/alc-app#387)。**開発用の印の有無に関係なく常に**、最後に出す。
// 上の `tabLabels` は変更前のラベルだけに絞って集めるので、新しいタブを足しても緑のまま
// (= 検知しない)。ここでは絞らずに全部のタブのボタンを集めて、並びを完全一致で固定する
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

  it('★ 印なし: 全部のタブは既存の 12 個のあとに「IT点呼 試験の手順」が 1 つ (計 13、IT点呼 は無い)', async () => {
    const wrapper = await mountDashboard()
    expect(allTabLabels(wrapper)).toEqual([...TABS_BEFORE, GUIDE_LABEL])
    expect(allTabLabels(wrapper)).not.toContain('IT点呼')
    wrapper.unmount()
  })

  it('★ 印あり: 全部のタブは 14 個で、IT点呼 は遠隔点呼の直後、手順は最後', async () => {
    noteDeviceToken('manager-device', devDeviceJwt('dev-manager'))
    const wrapper = await mountDashboard()
    const labels = allTabLabels(wrapper)
    expect(labels).toHaveLength(14)
    expect(labels[labels.indexOf('遠隔点呼') + 1]).toBe('IT点呼')
    expect(labels[labels.length - 1]).toBe(GUIDE_LABEL)
    expect(labels.filter(l => l !== 'IT点呼' && l !== GUIDE_LABEL)).toEqual(TABS_BEFORE)
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
