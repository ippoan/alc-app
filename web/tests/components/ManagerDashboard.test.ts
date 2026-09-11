import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerDashboard from '~/components/ManagerDashboard.vue'

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
})
