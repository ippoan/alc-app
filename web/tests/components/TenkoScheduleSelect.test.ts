import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoScheduleSelect from '~/components/TenkoScheduleSelect.vue'
import { noPendingSchedule } from '~/utils/employee-lookup-messages'
import type { TenkoSchedule, TenkoSession } from '~/types'

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

function makeSession(overrides?: Partial<TenkoSession>): TenkoSession {
  return {
    id: 'sess-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    schedule_id: null,
    tenko_type: 'pre_operation',
    status: 'medical_pending',
    identity_verified_at: null,
    identity_face_photo_url: null,
    measurement_id: null,
    alcohol_result: null,
    alcohol_value: null,
    alcohol_tested_at: null,
    alcohol_face_photo_url: null,
    temperature: null,
    systolic: null,
    diastolic: null,
    pulse: null,
    medical_measured_at: null,
    medical_manual_input: null,
    instruction_confirmed_at: null,
    report_vehicle_road_status: null,
    report_driver_alternation: null,
    report_no_report: null,
    report_submitted_at: null,
    location: null,
    responsible_manager_name: null,
    cancel_reason: null,
    interrupted_at: null,
    resumed_at: null,
    resume_reason: null,
    resumed_by_user_id: null,
    self_declaration: null,
    safety_judgment: null,
    daily_inspection: null,
    carrying_items_checked: null,
    started_at: null,
    completed_at: null,
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
  // --- 途中で止まった点呼の再開 (Refs ippoan/alc-app#343) ---

  it('resumableSessions を渡さなければ再開の導線は出ない (既定は今までどおり)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [makeSchedule()], employeeName: '田中' },
    })

    expect(wrapper.find('[data-testid="resume-session"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('続きから再開')

    wrapper.unmount()
  })

  it('★ 何がどこまで済んでいるかを出す (種別 / 状態 / 開始時刻)', async () => {
    const stuck = makeSession({ status: 'medical_pending', started_at: '2026-03-31T13:52:00Z' })
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [], employeeName: '田中', resumableSessions: [stuck] },
    })

    const btn = wrapper.find('[data-testid="resume-session"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('業務前')
    expect(btn.text()).toContain('医療測定待ち')
    expect(btn.text()).toContain('開始')
    // 「再開できます」だけで済ませない — 時刻まで見せる
    expect(btn.text()).toMatch(/開始 .*\d/)

    wrapper.unmount()
  })

  it('started_at が無い行は「開始時刻 不明」と正直に出す', async () => {
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [], employeeName: '田中', resumableSessions: [makeSession({ started_at: null })] },
    })

    expect(wrapper.find('[data-testid="resume-session"]').text()).toContain('開始時刻 不明')

    wrapper.unmount()
  })

  it('押すと resume が そのセッションで発火する', async () => {
    const stuck = makeSession({ id: 'sess-stuck' })
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: { schedules: [], employeeName: '田中', resumableSessions: [stuck] },
    })

    await wrapper.find('[data-testid="resume-session"]').trigger('click')
    expect(wrapper.emitted('resume')![0]).toEqual([stuck])

    wrapper.unmount()
  })

  it('再開の候補があっても、予定一覧と「予定なしで業務後として進む」はそのまま出る', async () => {
    const wrapper = await mountSuspended(TenkoScheduleSelect, {
      props: {
        schedules: [makeSchedule()],
        employeeName: '田中',
        resumableSessions: [makeSession({ status: 'carrying_items_pending' })],
      },
    })

    expect(wrapper.text()).toContain('管理者')
    expect(wrapper.text()).toContain('携行品確認待ち')
    expect(wrapper.find('[data-testid="no-schedule-post-operation"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
