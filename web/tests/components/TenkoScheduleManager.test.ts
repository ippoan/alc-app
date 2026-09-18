import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoScheduleManager from '~/components/TenkoScheduleManager.vue'

// #321: 業務前 (pre_operation) はサーバ側 (rust-alc-api validate_schedule()) が
// 指示事項を必須にしているが、画面は既定 (業務前) で「(任意)」のプレースホルダを
// 出し続け、空のまま送信して 400 になっていた。フロント側で表示と送信前チェックを直す。

vi.mock('~/utils/api', () => ({
  getEmployees: vi.fn(async () => [{ id: 'emp-1', name: '山田太郎' }]),
  listSchedules: vi.fn(async () => ({ schedules: [], total: 0, page: 1, per_page: 20 })),
  createSchedule: vi.fn(async () => ({})),
  batchCreateSchedules: vi.fn(async () => []),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}))

import { createSchedule } from '~/utils/api'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function openFormWithRow(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await flush()
  await wrapper.find('button.bg-green-600').trigger('click')
  await wrapper.vm.$nextTick()
}

function fillRequiredFields(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  const row = (wrapper.vm as any).newRows[0]
  row.employee_id = 'emp-1'
  row.scheduled_at = '2026-09-18T09:00'
  row.responsible_manager_name = '鈴木一郎'
}

describe('TenkoScheduleManager — #321 業務前の指示事項', () => {
  beforeEach(() => vi.clearAllMocks())

  it('業務前を選んでいるとき指示事項の入力欄が「(必須)」表示になる', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    const instructionInput = wrapper.find('input[placeholder*="指示事項"]')
    expect(instructionInput.attributes('placeholder')).toBe('指示事項 (必須)')
    wrapper.unmount()
  })

  it('業務後を選ぶと指示事項の表示が「(任意)」のままになる', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    const typeSelect = wrapper.find('select')
    // newRows[0].tenko_type を業務後に切り替える
    ;(wrapper.vm as any).newRows[0].tenko_type = 'post_operation'
    await wrapper.vm.$nextTick()
    const instructionInput = wrapper.find('input[placeholder*="指示事項"]')
    expect(instructionInput.attributes('placeholder')).toBe('指示事項 (任意)')
    wrapper.unmount()
  })

  it('業務前 + 指示事項が空のまま作成を呼んでも送信されず理由が出る', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    fillRequiredFields(wrapper)
    await wrapper.vm.$nextTick()

    await (wrapper.vm as any).handleCreate()
    await flush()

    expect(createSchedule).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('業務前は指示事項の入力が必須です')
    wrapper.unmount()
  })

  it('業務前 + 指示事項が空のとき作成ボタンが無効化される', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    fillRequiredFields(wrapper)
    await wrapper.vm.$nextTick()

    const createButton = wrapper.findAll('button').find(b => b.text().includes('作成') && !b.text().includes('行追加'))
    expect(createButton?.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('業務後 + 指示事項が空のときは従来どおり送信できる (回帰)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    fillRequiredFields(wrapper)
    ;(wrapper.vm as any).newRows[0].tenko_type = 'post_operation'
    await wrapper.vm.$nextTick()

    await (wrapper.vm as any).handleCreate()
    await flush()

    expect(createSchedule).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
