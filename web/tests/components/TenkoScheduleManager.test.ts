import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoScheduleManager from '~/components/TenkoScheduleManager.vue'

// #321: 業務前 (pre_operation) はサーバ側 (rust-alc-api validate_schedule()) が
// 指示事項を必須にしているが、画面は既定 (業務前) で「(任意)」のプレースホルダを
// 出し続け、空のまま送信して 400 になっていた。フロント側で表示と送信前チェックを直す。

vi.mock('~/utils/api', async importOriginal => ({
  // 席の鍵が取れないときに `request()` が投げる文言。実物の定数をそのまま使う
  MANAGER_DEVICE_AUTH_FAILED_MESSAGE: (await importOriginal<typeof import('~/utils/api')>()).MANAGER_DEVICE_AUTH_FAILED_MESSAGE,
  getEmployees: vi.fn(async () => [{ id: 'emp-1', name: '山田太郎' }]),
  listSchedules: vi.fn(async () => ({ schedules: [], total: 0, page: 1, per_page: 20 })),
  createSchedule: vi.fn(async () => ({})),
  batchCreateSchedules: vi.fn(async () => []),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getTenkoSettings: vi.fn(async () => ({ overdue_minutes: 60 })),
  updateTenkoSettings: vi.fn(async (d: { overdue_minutes: number }) => d),
}))

import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE, createSchedule, deleteSchedule, listSchedules, updateSchedule, getTenkoSettings, updateTenkoSettings } from '~/utils/api'

// 席の鍵のトークンが、失敗の後に取れた回数 (実物は useManagerDeviceToken が数える module の ref)
const recoveredCountRef = ref(0)
mockNuxtImport('useManagerDeviceToken', () => () => ({ managerJwtRecoveredCount: recoveredCountRef }))

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

// #333: 乗務員フィルタは EmployeeSearchSelect (検索できる部品) へ差し替え済みだが、
// 新規作成フォームの v-for 行 (newRows) は配列要素への v-model なので、
// defineModel の bind が効くかを別途確かめる (壊れやすい箇所)。
describe('TenkoScheduleManager — #333 新規作成行の乗務員セレクト', () => {
  beforeEach(() => vi.clearAllMocks())

  it('行の乗務員セレクトで候補を選ぶとその行の employee_id に id が入る', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)

    // フィルタ欄 (index 0) と新規行 (index 1) の 2 つの EmployeeSearchSelect が並ぶ
    const rowSelect = wrapper.findAllComponents({ name: 'EmployeeSearchSelect' })[1]!
    await rowSelect.find('[data-testid="employee-search-input"]').trigger('focus')
    const option = rowSelect.findAll('[data-testid="employee-search-option"]')[0]!
    await option.trigger('click')
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).newRows[0].employee_id).toBe('emp-1')
    wrapper.unmount()
  })
})

// Refs ippoan/alc-app#387: 席の鍵が取れずに「この席の端末を確認できませんでした」が出た後、
// 席の鍵が取れても読み直す契機が無く、文言が残り続けていた。`fetchData` は表を「読み込み中」に
// 差し替えて error を消すので、その文言が出ているとき以外・操作の最中には割り込ませない。
describe('TenkoScheduleManager — 席の鍵が取れたら一覧を読み直す (#387)', () => {
  const EMPTY = { schedules: [], total: 0, page: 1, per_page: 20 }
  const SCHEDULE = {
    id: 's-1', employee_id: 'emp-1', tenko_type: 'pre_operation', scheduled_at: '2026-09-18T00:00:00Z',
    responsible_manager_name: '鈴木一郎', instruction: '安全運転', consumed: false,
  }
  const listMock = vi.mocked(listSchedules)
  /** 一覧の読み込みの回数 (指示事項の候補の読み込み `per_page: 200` は数えない) */
  const tableCalls = () => listMock.mock.calls.filter(c => c[0]?.per_page !== 200).length
  const keyFailure = () => Promise.reject(new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE))
  /** 返らないままの呼び出し (操作の最中を作る) */
  const hanging = () => new Promise<never>(() => {})

  beforeEach(() => {
    vi.clearAllMocks()
    recoveredCountRef.value = 0
    listMock.mockReset()
    listMock.mockResolvedValue(EMPTY as never)
    vi.mocked(deleteSchedule).mockReset()
    vi.mocked(updateSchedule).mockReset()
  })

  /** 席の鍵が取れた (失敗の後の成功) ことを知らせ、読み直しが在れば終わるまで待つ */
  async function recover(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
    recoveredCountRef.value += 1
    await flush()
    await wrapper.vm.$nextTick()
  }

  /** 席の鍵の文言が出ている画面を用意する (mount の読み込みが失敗した) */
  async function mountWithKeyFailure() {
    listMock.mockImplementationOnce(keyFailure)
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(tableCalls()).toBe(1)
    return wrapper
  }

  it('★ 席の鍵の文言が出ている → 席の鍵が取れた → 読み直して文言が消える', async () => {
    const wrapper = await mountWithKeyFailure()

    await recover(wrapper)

    expect(tableCalls()).toBe(2)
    expect(wrapper.text()).not.toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    wrapper.unmount()
  })

  it('回数が変わらなければ読み直さない (mount の時点の値では走らない)', async () => {
    recoveredCountRef.value = 3
    const wrapper = await mountWithKeyFailure()
    await flush()
    expect(tableCalls()).toBe(1)
    wrapper.unmount()
  })

  it('別のエラー (一覧の取得の失敗) が出ているときは読み直さない', async () => {
    listMock.mockRejectedValueOnce(new Error('API エラー (500)'))
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('API エラー (500)')

    await recover(wrapper)

    expect(tableCalls()).toBe(1)
    expect(wrapper.text()).toContain('API エラー (500)')
    wrapper.unmount()
  })

  it('★ 削除の失敗の文言が出ているときは読み直さない (文言を消さない)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    vi.mocked(deleteSchedule).mockRejectedValueOnce(new Error('削除できませんでした'))
    await (wrapper.vm as any).handleDelete('s-1')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('削除できませんでした')

    await recover(wrapper)

    expect(tableCalls()).toBe(1)
    expect(wrapper.text()).toContain('削除できませんでした')
    wrapper.unmount()
  })

  it('エラーが無いときは読み直さない (正常に出ている一覧を「読み込み中」に差し替えない)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    expect(tableCalls()).toBe(1)

    await recover(wrapper)

    expect(tableCalls()).toBe(1)
    wrapper.unmount()
  })

  it('新規作成のフォームを開いている間は読み直さない', async () => {
    const wrapper = await mountWithKeyFailure()
    await openFormWithRow(wrapper)

    await recover(wrapper)

    expect(tableCalls()).toBe(1)
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    wrapper.unmount()
  })

  it('編集中は読み直さない', async () => {
    const wrapper = await mountWithKeyFailure()
    ;(wrapper.vm as any).startEdit(SCHEDULE)
    await wrapper.vm.$nextTick()

    await recover(wrapper)

    expect(tableCalls()).toBe(1)
    wrapper.unmount()
  })

  // 保存・更新・削除は、送った後の一覧の読み直しが返るまで「最中」の印が立っている。
  // そのあいだに「検索」で席の鍵の文言が出ても、読み直しは割り込ませない
  it('保存中は読み直さない', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    fillRequiredFields(wrapper)
    ;(wrapper.vm as any).newRows[0].instruction = '安全運転'
    listMock.mockImplementationOnce(hanging).mockImplementationOnce(keyFailure)
    void (wrapper.vm as any).handleCreate()
    await flush()
    expect(tableCalls()).toBe(2)
    ;(wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(tableCalls()).toBe(3)

    await recover(wrapper)

    expect(tableCalls()).toBe(3)
    wrapper.unmount()
  })

  it('更新中は読み直さない', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    ;(wrapper.vm as any).startEdit(SCHEDULE)
    // 編集を始めると指示事項の候補を読むので、それが済んでから一覧の応答を仕込む
    await flush()
    vi.mocked(updateSchedule).mockResolvedValueOnce({} as never)
    listMock.mockImplementationOnce(hanging).mockImplementationOnce(keyFailure)
    void (wrapper.vm as any).handleUpdate()
    await flush()
    expect(tableCalls()).toBe(2)
    ;(wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    await recover(wrapper)

    expect(tableCalls()).toBe(3)
    wrapper.unmount()
  })

  it('削除中は読み直さない', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    vi.mocked(deleteSchedule).mockImplementationOnce(hanging)
    void (wrapper.vm as any).handleDelete('s-1')
    listMock.mockImplementationOnce(keyFailure)
    ;(wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(tableCalls()).toBe(2)

    await recover(wrapper)

    expect(tableCalls()).toBe(2)
    wrapper.unmount()
  })
})


// 自己点検表の不足を埋める: 予定に車両番号、予定超過の分数
describe('TenkoScheduleManager — 車両番号と予定超過の分数', () => {
  const SCHEDULE = {
    id: 's-9', employee_id: 'emp-1', tenko_type: 'pre_operation', scheduled_at: '2026-09-18T00:00:00Z',
    responsible_manager_name: '鈴木一郎', instruction: '安全運転', consumed: false, vehicle_number: '品川 100 あ 12-34',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listSchedules).mockReset()
    vi.mocked(listSchedules).mockResolvedValue({ schedules: [SCHEDULE], total: 1, page: 1, per_page: 20 } as never)
    vi.mocked(getTenkoSettings).mockResolvedValue({ overdue_minutes: 60 })
    vi.mocked(updateTenkoSettings).mockImplementation(async d => d)
  })

  it('一覧に車両番号が出る (無い予定は「-」)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="schedule-vehicle-number"]').text()).toBe('品川 100 あ 12-34')
    vi.mocked(listSchedules).mockResolvedValue({ schedules: [{ ...SCHEDULE, vehicle_number: null }], total: 1, page: 1, per_page: 20 } as never)
    await (wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="schedule-vehicle-number"]').text()).toBe('-')
    wrapper.unmount()
  })

  it('新規作成で入力した車両番号が createSchedule に載る (空なら載せない)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    fillRequiredFields(wrapper)
    const row = (wrapper.vm as any).newRows[0]
    row.instruction = '指示'
    row.vehicle_number = ' 品川 100 あ 12-34 '
    await (wrapper.vm as any).handleCreate()
    await flush()
    expect(vi.mocked(createSchedule).mock.calls[0]![0]).toMatchObject({ vehicle_number: '品川 100 あ 12-34' })

    await openFormWithRow(wrapper)
    await wrapper.find('button.bg-green-600').trigger('click')
    fillRequiredFields(wrapper)
    const row2 = (wrapper.vm as any).newRows[0]
    row2.instruction = '指示'
    await (wrapper.vm as any).handleCreate()
    await flush()
    expect(vi.mocked(createSchedule).mock.calls[1]![0].vehicle_number).toBeUndefined()
    wrapper.unmount()
  })

  it('編集で車両番号を直して保存すると updateSchedule に載る', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    await wrapper.findAll('button').find(b => b.text() === '編集')!.trigger('click')
    const input = wrapper.find('[data-testid="edit-vehicle-number"]')
    expect((input.element as HTMLInputElement).value).toBe('品川 100 あ 12-34')
    await input.setValue('横浜 200 い 5-6')
    await wrapper.findAll('button').find(b => b.text() === '保存' && b.classes().includes('bg-blue-600') && b.attributes('data-testid') !== 'overdue-save')!.trigger('click')
    await flush()
    expect(vi.mocked(updateSchedule).mock.calls[0]![1]).toMatchObject({ vehicle_number: '横浜 200 い 5-6' })
    wrapper.unmount()
  })

  it('予定超過の分数は設定から読み込まれ、保存すると updateTenkoSettings に数値で送る', async () => {
    vi.mocked(getTenkoSettings).mockResolvedValue({ overdue_minutes: 90 })
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    const input = wrapper.find('[data-testid="overdue-minutes"]')
    expect((input.element as HTMLInputElement).value).toBe('90')
    await input.setValue('120')
    await wrapper.find('[data-testid="overdue-save"]').trigger('click')
    await flush()
    expect(updateTenkoSettings).toHaveBeenCalledWith({ overdue_minutes: 120 })
    expect(wrapper.find('[data-testid="overdue-saved"]').exists()).toBe(true)
    await input.setValue('130')
    expect(wrapper.find('[data-testid="overdue-saved"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each(['0', '1441', '1.5', ''])('範囲外の分数 (%s) は保存ボタンが無効で送らない', async v => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.find('[data-testid="overdue-minutes"]').setValue(v)
    expect(wrapper.find('[data-testid="overdue-save"]').attributes('disabled')).toBeDefined()
    await (wrapper.vm as any).saveOverdue()
    await flush()
    expect(updateTenkoSettings).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="overdue-error"]').text()).toContain('1 〜 1440')
    wrapper.unmount()
  })

  it('設定の取得・保存に失敗したら理由を出す (非 Error は既定文言)', async () => {
    vi.mocked(getTenkoSettings).mockRejectedValueOnce(new Error('取得できません'))
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="overdue-error"]').text()).toBe('取得できません')

    vi.mocked(updateTenkoSettings).mockRejectedValueOnce('x')
    await wrapper.find('[data-testid="overdue-minutes"]').setValue('30')
    await wrapper.find('[data-testid="overdue-save"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="overdue-error"]').text()).toBe('設定の保存エラー')

    vi.mocked(getTenkoSettings).mockRejectedValueOnce('x')
    await (wrapper.vm as any).loadSettings()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="overdue-error"]').text()).toBe('設定の取得エラー')
    wrapper.unmount()
  })
})

describe('TenkoScheduleManager — 管理者名と指示事項の選択', () => {
  beforeEach(() => vi.clearAllMocks())

  it('★ 管理者名は運行管理者・管理者の社員から選ぶ (乗務員は出さない)', async () => {
    const { getEmployees } = await import('~/utils/api')
    vi.mocked(getEmployees).mockResolvedValueOnce([
      { id: 'm-1', name: '鈴木一郎', role: ['manager'] },
      { id: 'a-1', name: '佐藤花子', role: ['admin', 'driver'] },
      { id: 'd-1', name: '山田太郎', role: ['driver'] },
    ] as never)
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    const options = wrapper.find('[data-testid="new-manager-select"]').findAll('option').map(o => o.text())
    expect(options).toEqual(['管理者を選択', '鈴木一郎', '佐藤花子'])
  })

  it('編集では、候補に無い今の管理者名も選べるように残す', async () => {
    const { getEmployees } = await import('~/utils/api')
    vi.mocked(getEmployees).mockResolvedValueOnce([{ id: 'm-1', name: '鈴木一郎', role: ['manager'] }] as never)
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    ;(wrapper.vm as any).startEdit({
      id: 's-9', employee_id: 'emp-1', tenko_type: 'pre_operation', scheduled_at: '2026-09-18T00:00:00Z',
      responsible_manager_name: '退職 次郎', instruction: '安全運転', consumed: false,
    })
    await flush()
    await wrapper.vm.$nextTick()
    const options = wrapper.find('[data-testid="edit-manager-select"]').findAll('option').map(o => o.text())
    expect(options).toEqual(['退職 次郎', '鈴木一郎'])
  })

  it('★ 指示事項は、これまでの予定で使った指示を候補に出す (重複・空は除く)。取れなければ候補なし', async () => {
    vi.mocked(listSchedules).mockImplementation(async (f) => (f?.per_page === 200
      ? { schedules: [{ instruction: '安全運転' }, { instruction: ' 安全運転 ' }, { instruction: '' }, { instruction: null }, { instruction: '休憩を取る' }], total: 5, page: 1, per_page: 200 }
      : { schedules: [], total: 0, page: 1, per_page: 20 }) as never)
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await openFormWithRow(wrapper)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="new-instruction"]').attributes('list')).toBe('instruction-options')
    const opts = wrapper.find('[data-testid="instruction-options"]').findAll('option').map(o => o.attributes('value'))
    expect(opts).toEqual(['安全運転', '休憩を取る'])
    expect(listSchedules).toHaveBeenCalledWith({ page: 1, per_page: 200 })

    vi.mocked(listSchedules).mockImplementation(async (f) => {
      if (f?.per_page === 200) throw new Error('offline')
      return { schedules: [], total: 0, page: 1, per_page: 20 } as never
    })
    ;(wrapper.vm as any).showForm = false
    await wrapper.vm.$nextTick()
    ;(wrapper.vm as any).showForm = true
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="instruction-options"]').findAll('option')).toHaveLength(0)
    vi.mocked(listSchedules).mockReset()
    vi.mocked(listSchedules).mockResolvedValue({ schedules: [], total: 0, page: 1, per_page: 20 } as never)
  })
})
