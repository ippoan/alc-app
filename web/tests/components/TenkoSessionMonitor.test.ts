import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoSessionMonitor from '~/components/TenkoSessionMonitor.vue'

// 「点呼記録」タブを廃止し、CSV 出力をここへ移植する (Refs #238, ippoan/alc-app-s3#135)

const listTenkoSessionsMock = vi.fn(async () => ({ sessions: [] as any[], total: 0, page: 1, per_page: 20 }))
const getEmployeesMock = vi.fn(async () => [] as any[])
const downloadTenkoRecordsCsvMock = vi.fn(async () => {})
const getMeasurementMock = vi.fn(async (_id: string) => ({}) as any)

vi.mock('~/utils/api', () => ({
  listTenkoSessions: (...args: any[]) => listTenkoSessionsMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
  downloadTenkoRecordsCsv: (...args: any[]) => downloadTenkoRecordsCsvMock(...args),
  getMeasurement: (...args: any[]) => getMeasurementMock(...args),
  interruptTenkoSession: vi.fn(),
  resumeTenkoSession: vi.fn(),
  cancelTenkoSession: vi.fn(),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const SESSION_NORMAL = {
  id: 's-1', tenant_id: 't-1', employee_id: 'emp-1', tenko_type: 'normal', status: 'completed',
  responsible_manager_name: null, started_at: '2026-09-12T00:00:00Z', created_at: '2026-09-12T00:00:00Z',
  completed_at: '2026-09-12T00:05:00Z', measurement_id: null,
}

const SESSION_WITH_MEASUREMENT = {
  ...SESSION_NORMAL, id: 's-2', measurement_id: 'm-1',
}

async function mountMonitor() {
  const wrapper = await mountSuspended(TenkoSessionMonitor, {
    global: { stubs: { MeasurementDetail: true } },
  })
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

describe('TenkoSessionMonitor — 一覧の行から測定詳細 (動画) を開く', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_WITH_MEASUREMENT], total: 1, page: 1, per_page: 20 })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    downloadTenkoRecordsCsvMock.mockClear()
    getMeasurementMock.mockClear()
    getMeasurementMock.mockResolvedValue({ id: 'm-1', employee_id: 'emp-1' } as any)
  })

  it('measurement_id があるセッションの行では測定詳細ボタンが出て、押すと getMeasurement が id で呼ばれ MeasurementDetail が描画される', async () => {
    const wrapper = await mountMonitor()

    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    expect(button).toBeTruthy()
    await button!.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementMock).toHaveBeenCalledWith('m-1')
    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('行の測定詳細ボタンを押してもセッション詳細モーダルは開かない', async () => {
    const wrapper = await mountMonitor()

    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    await button!.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('セッション詳細')
    wrapper.unmount()
  })

  it('measurement_id が null のセッションでは行に測定詳細ボタンが出ない', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    const wrapper = await mountMonitor()

    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    expect(button).toBeFalsy()
    wrapper.unmount()
  })

  it('getMeasurement が reject すると MeasurementDetail は出ず、一覧の上にエラー表示が出て、他の欄 (種別) は出たままになる', async () => {
    getMeasurementMock.mockRejectedValue(new Error('network error'))
    const wrapper = await mountMonitor()

    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    await button!.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).exists()).toBe(false)
    expect(wrapper.text()).toContain('測定詳細を取得できませんでした')
    expect(wrapper.text()).toContain('通常')
    wrapper.unmount()
  })

  it('2 行あるとき、1 行目を押して読み込み中の間、2 行目のボタンは disabled にならない', async () => {
    const SESSION_WITH_MEASUREMENT_2 = { ...SESSION_WITH_MEASUREMENT, id: 's-3', measurement_id: 'm-2' }
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_WITH_MEASUREMENT, SESSION_WITH_MEASUREMENT_2], total: 2, page: 1, per_page: 20 })
    let resolveGetMeasurement!: (v: any) => void
    getMeasurementMock.mockImplementation(() => new Promise(resolve => { resolveGetMeasurement = resolve }))
    const wrapper = await mountMonitor()

    const buttons = wrapper.findAll('button').filter(b => b.text().includes('測定詳細'))
    expect(buttons.length).toBe(2)
    await buttons[0]!.trigger('click')
    await wrapper.vm.$nextTick()

    const buttonsAfterClick = wrapper.findAll('button').filter(b => b.text().includes('測定詳細') || b.text().includes('読み込み中'))
    expect(buttonsAfterClick[0]!.attributes('disabled')).toBeDefined()
    expect(buttonsAfterClick[1]!.attributes('disabled')).toBeUndefined()

    resolveGetMeasurement({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()
    wrapper.unmount()
  })

  it('MeasurementDetail の close で消える', async () => {
    const wrapper = await mountMonitor()

    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    await button!.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    const detail = wrapper.findComponent({ name: 'MeasurementDetail' })
    expect(detail.exists()).toBe(true)
    detail.vm.$emit('close')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'MeasurementDetail' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('セッション詳細モーダルに測定詳細ボタンが無い', async () => {
    const wrapper = await mountMonitor()
    await wrapper.find('tbody > tr').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('セッション詳細')
    expect(wrapper.text()).not.toContain('測定詳細 (動画・顔写真)')
    wrapper.unmount()
  })

  it('種別フィルタに「通常」がある', async () => {
    const wrapper = await mountMonitor()
    const options = wrapper.findAll('select')[2]!.findAll('option')
    expect(options.some(o => o.attributes('value') === 'normal' && o.text() === '通常')).toBe(true)
    wrapper.unmount()
  })

  it('体温・血圧の列: 値があれば整形して出る', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_WITH_MEASUREMENT, temperature: 36.7, systolic: 120, diastolic: 80 }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    expect(row.text()).toContain('36.7 ℃')
    expect(row.text()).toContain('120/80')
    wrapper.unmount()
  })

  it('体温・血圧の列: 値が null なら "-" になる', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, temperature: null, systolic: null, diastolic: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const cells = wrapper.findAll('tbody > tr > td')
    expect(cells.map(c => c.text())).toContain('-')
    wrapper.unmount()
  })
})
