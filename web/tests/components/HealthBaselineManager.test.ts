import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HealthBaselineManager from '~/components/HealthBaselineManager.vue'

// #333: 乗務員セレクトを EmployeeSearchSelect へ差し替え。ここは機械的に employees を
// 渡すと「登録済みの乗務員」が再度選べてしまうため、unregisteredEmployees
// (ベースライン登録済みを除いた一覧) を渡している。その配線を確かめる。

vi.mock('~/utils/api', () => ({
  getEmployees: vi.fn(async () => [
    { id: 'emp-1', name: '山田太郎' },
    { id: 'emp-2', name: '鈴木花子' },
  ]),
  listBaselines: vi.fn(async () => ([
    { id: 'b-1', employee_id: 'emp-1', baseline_systolic: 120, baseline_diastolic: 80, baseline_temperature: 36.5, systolic_tolerance: 10, diastolic_tolerance: 10, temperature_tolerance: 0.5, measurement_validity_minutes: 30 },
  ])),
  createBaseline: vi.fn(async () => ({})),
  updateBaseline: vi.fn(),
  deleteBaseline: vi.fn(),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('HealthBaselineManager — #333 新規登録の乗務員セレクト', () => {
  beforeEach(() => vi.clearAllMocks())

  it('登録済み (emp-1) は候補に出ず、未登録 (emp-2) だけ出る', async () => {
    const wrapper = await mountSuspended(HealthBaselineManager)
    await flush()
    await wrapper.find('button.bg-green-600').trigger('click')
    await wrapper.vm.$nextTick()

    const select = wrapper.findComponent({ name: 'EmployeeSearchSelect' })
    await select.find('[data-testid="employee-search-input"]').trigger('focus')
    const optionTexts = select.findAll('[data-testid="employee-search-option"]').map(o => o.text())

    expect(optionTexts).toEqual(['鈴木花子'])
    expect(optionTexts).not.toContain('山田太郎')
    wrapper.unmount()
  })
})
