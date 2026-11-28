import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HealthBaselineManager from '~/components/HealthBaselineManager.vue'
import { createBaseline, listBaselines, updateBaseline } from '~/utils/api'

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

// 血圧の有効時間 (Refs ippoan/alc-app#676): 当日中 (null。既定) か分。体温の有効時間 (分) とは別の欄
describe('HealthBaselineManager — 血圧の有効時間', () => {
  const B1 = { id: 'b-1', employee_id: 'emp-1', baseline_systolic: 120, baseline_diastolic: 80, baseline_temperature: 36.5, systolic_tolerance: 10, diastolic_tolerance: 10, temperature_tolerance: 0.5, measurement_validity_minutes: 30 }

  beforeEach(() => vi.clearAllMocks())

  async function mountWith(rows: object[]) {
    vi.mocked(listBaselines).mockResolvedValue(rows as never)
    const wrapper = await mountSuspended(HealthBaselineManager)
    await flush()
    return wrapper
  }

  it('一覧は null (と古い backend の欄なし) を「当日中」、数を「N 分」と出す', async () => {
    const wrapper = await mountWith([
      { ...B1, bp_validity_minutes: null },
      { ...B1, id: 'b-2', employee_id: 'emp-2', bp_validity_minutes: 60 },
      { ...B1, id: 'b-3', employee_id: 'emp-3' },
    ])
    expect(wrapper.findAll('[data-testid="bp-validity"]').map(c => c.text())).toEqual(['当日中', '60 分', '当日中'])
    wrapper.unmount()
  })

  it('新規登録は既定で当日中 (null) を送り、「分で決める」にすれば分を送る', async () => {
    const wrapper = await mountWith([])
    const open = async () => {
      await wrapper.find('button.bg-green-600').trigger('click')
      await wrapper.vm.$nextTick()
      const select = wrapper.findComponent({ name: 'EmployeeSearchSelect' })
      await select.find('[data-testid="employee-search-input"]').trigger('focus')
      await select.find('[data-testid="employee-search-option"]').trigger('click')
      await wrapper.vm.$nextTick()
    }
    const submit = async () => {
      await wrapper.findAll('button').find(b => b.text() === '登録')!.trigger('click')
      await flush()
    }
    await open()
    expect(wrapper.find('[data-testid="new-bp-minutes"]').exists()).toBe(false)
    await submit()
    expect(createBaseline).toHaveBeenLastCalledWith(expect.objectContaining({ employee_id: 'emp-1', measurement_validity_minutes: 30, bp_validity_minutes: null }))

    await open()
    await wrapper.find('[data-testid="new-bp-mode"]').setValue('minutes')
    expect((wrapper.find('[data-testid="new-bp-minutes"]').element as HTMLInputElement).value).toBe('30')
    await wrapper.find('[data-testid="new-bp-minutes"]').setValue('45')
    await submit()
    expect(createBaseline).toHaveBeenLastCalledWith(expect.objectContaining({ bp_validity_minutes: 45 }))
    wrapper.unmount()
  })

  it('編集は今の値から始め、当日中に戻すと null・分にすると分を送る', async () => {
    vi.mocked(updateBaseline).mockResolvedValue({} as never)
    const wrapper = await mountWith([{ ...B1, bp_validity_minutes: 60 }])
    const edit = async () => {
      await wrapper.findAll('button').find(b => b.text() === '編集')!.trigger('click')
      await wrapper.vm.$nextTick()
    }
    const save = async () => {
      await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
      await flush()
    }
    await edit()
    expect((wrapper.find('[data-testid="edit-bp-mode"]').element as HTMLSelectElement).value).toBe('minutes')
    expect((wrapper.find('[data-testid="edit-bp-minutes"]').element as HTMLInputElement).value).toBe('60')
    await wrapper.find('[data-testid="edit-bp-mode"]').setValue('same_day')
    expect(wrapper.find('[data-testid="edit-bp-minutes"]').exists()).toBe(false)
    // 保存の後に引き直す一覧は当日中の行
    vi.mocked(listBaselines).mockResolvedValue([{ ...B1, bp_validity_minutes: null }] as never)
    await save()
    expect(updateBaseline).toHaveBeenLastCalledWith('emp-1', expect.objectContaining({ measurement_validity_minutes: 30, bp_validity_minutes: null }))

    expect(wrapper.find('[data-testid="bp-validity"]').text()).toBe('当日中')
    await edit()
    expect((wrapper.find('[data-testid="edit-bp-mode"]').element as HTMLSelectElement).value).toBe('same_day')
    await wrapper.find('[data-testid="edit-bp-mode"]').setValue('minutes')
    await wrapper.find('[data-testid="edit-bp-minutes"]').setValue('90')
    await save()
    expect(updateBaseline).toHaveBeenLastCalledWith('emp-1', expect.objectContaining({ bp_validity_minutes: 90 }))
    wrapper.unmount()
  })
})
