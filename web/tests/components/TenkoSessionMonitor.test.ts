import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoSessionMonitor from '~/components/TenkoSessionMonitor.vue'

// 「点呼記録」タブを廃止し、CSV 出力をここへ移植する (Refs #238, ippoan/alc-app-s3#135)

const listTenkoSessionsMock = vi.fn(async () => ({ sessions: [] as any[], total: 0, page: 1, per_page: 20 }))
const getEmployeesMock = vi.fn(async () => [] as any[])
const downloadTenkoRecordsCsvMock = vi.fn(async () => {})

vi.mock('~/utils/api', () => ({
  listTenkoSessions: (...args: any[]) => listTenkoSessionsMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
  downloadTenkoRecordsCsv: (...args: any[]) => downloadTenkoRecordsCsvMock(...args),
  interruptTenkoSession: vi.fn(),
  resumeTenkoSession: vi.fn(),
  cancelTenkoSession: vi.fn(),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const SESSION_NORMAL = {
  id: 's-1', tenant_id: 't-1', employee_id: 'emp-1', tenko_type: 'normal', status: 'completed',
  responsible_manager_name: null, started_at: '2026-09-12T00:00:00Z', created_at: '2026-09-12T00:00:00Z',
  completed_at: '2026-09-12T00:05:00Z',
}

async function mountMonitor() {
  const wrapper = await mountSuspended(TenkoSessionMonitor)
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('TenkoSessionMonitor — 点呼記録タブ統合後の CSV 出力と種別表示', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    downloadTenkoRecordsCsvMock.mockClear()
  })

  it('CSV 出力ボタンを押すと、今の絞り込みの値で downloadTenkoRecordsCsv を呼ぶ', async () => {
    const wrapper = await mountMonitor()
    const dateFromInput = wrapper.find('input[type="date"]')
    await dateFromInput.setValue('2026-09-01')
    const csvButton = wrapper.findAll('button').find(b => b.text().includes('CSV出力'))
    expect(csvButton).toBeTruthy()
    await csvButton!.trigger('click')
    await flush()
    expect(downloadTenkoRecordsCsvMock).toHaveBeenCalledTimes(1)
    expect(downloadTenkoRecordsCsvMock.mock.calls[0][0]).toMatchObject({ date_from: '2026-09-01' })
    wrapper.unmount()
  })

  it('種別 normal の行は「通常」と灰色バッジで出る', async () => {
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    expect(row.text()).toContain('通常')
    const badge = row.findAll('span').find(s => s.text() === '通常')
    expect(badge).toBeTruthy()
    expect(badge!.classes()).toContain('bg-gray-100')
    expect(badge!.classes()).toContain('text-gray-700')
    wrapper.unmount()
  })
})
