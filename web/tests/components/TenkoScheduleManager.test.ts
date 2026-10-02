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
}))

import { MANAGER_DEVICE_AUTH_FAILED_MESSAGE, createSchedule, deleteSchedule, listSchedules, updateSchedule } from '~/utils/api'

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
    expect(listMock).toHaveBeenCalledTimes(1)
    return wrapper
  }

  it('★ 席の鍵の文言が出ている → 席の鍵が取れた → 読み直して文言が消える', async () => {
    const wrapper = await mountWithKeyFailure()

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    wrapper.unmount()
  })

  it('回数が変わらなければ読み直さない (mount の時点の値では走らない)', async () => {
    recoveredCountRef.value = 3
    const wrapper = await mountWithKeyFailure()
    await flush()
    expect(listMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('別のエラー (一覧の取得の失敗) が出ているときは読み直さない', async () => {
    listMock.mockRejectedValueOnce(new Error('API エラー (500)'))
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('API エラー (500)')

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(1)
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

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('削除できませんでした')
    wrapper.unmount()
  })

  it('エラーが無いときは読み直さない (正常に出ている一覧を「読み込み中」に差し替えない)', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    expect(listMock).toHaveBeenCalledTimes(1)

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('新規作成のフォームを開いている間は読み直さない', async () => {
    const wrapper = await mountWithKeyFailure()
    await openFormWithRow(wrapper)

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    wrapper.unmount()
  })

  it('編集中は読み直さない', async () => {
    const wrapper = await mountWithKeyFailure()
    ;(wrapper.vm as any).startEdit(SCHEDULE)
    await wrapper.vm.$nextTick()

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(1)
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
    expect(listMock).toHaveBeenCalledTimes(2)
    ;(wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
    expect(listMock).toHaveBeenCalledTimes(3)

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('更新中は読み直さない', async () => {
    const wrapper = await mountSuspended(TenkoScheduleManager)
    await flush()
    ;(wrapper.vm as any).startEdit(SCHEDULE)
    vi.mocked(updateSchedule).mockResolvedValueOnce({} as never)
    listMock.mockImplementationOnce(hanging).mockImplementationOnce(keyFailure)
    void (wrapper.vm as any).handleUpdate()
    await flush()
    expect(listMock).toHaveBeenCalledTimes(2)
    ;(wrapper.vm as any).applyFilter()
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(3)
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
    expect(listMock).toHaveBeenCalledTimes(2)

    await recover(wrapper)

    expect(listMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
