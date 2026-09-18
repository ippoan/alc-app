import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoScheduleSelect from '~/components/TenkoScheduleSelect.vue'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'
import type { TenkoSchedule } from '~/types'

function makeSchedule(overrides?: Partial<TenkoSchedule>): TenkoSchedule {
  return {
    id: 'sched-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    tenko_type: 'pre_operation',
    responsible_manager_name: '管理者',
    scheduled_at: '2026-03-31T08:00:00Z',
    instruction: null,
    consumed: false,
    consumed_by_session_id: null,
    overdue_notified_at: null,
    created_at: '2026-03-31T00:00:00Z',
    updated_at: '2026-03-31T00:00:00Z',
    ...overrides,
  }
}

// 業務後は予定が無くても進められる導線 (Refs ippoan/alc-app#322)
describe('TenkoScheduleSelect', () => {
  it('予定を選ぶと select が発火する (従来どおり)', async () => {
    const sched = makeSchedule()
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [sched], employeeName: '田中' },
    })

    const btn = wrapper.findAll('button').find(b => b.text().includes('管理者'))
    await btn!.trigger('click')
    expect(wrapper.emitted('select')![0]).toEqual([sched])

    wrapper.unmount()
  })

  it('予定 0 件 → noPendingSchedule() の文言を出す', async () => {
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [], employeeName: '田中' },
    })

    expect(wrapper.text()).toContain(noPendingSchedule())

    wrapper.unmount()
  })

  it('「予定なしで業務後として進む」ボタンは予定の有無に関わらず出て、押すと no-schedule が発火する', async () => {
    const sched = makeSchedule({ tenko_type: 'pre_operation' })
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [sched], employeeName: '田中' },
    })

    const btn = wrapper.find('[data-testid="no-schedule-post-operation"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('no-schedule')).toHaveLength(1)

    wrapper.unmount()
  })

  it('予定 0 件でも「予定なしで業務後として進む」ボタンが出る', async () => {
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [], employeeName: '田中' },
    })

    expect(wrapper.find('[data-testid="no-schedule-post-operation"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
