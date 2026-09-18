import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoSessionMonitor from '~/components/TenkoSessionMonitor.vue'

// 「点呼記録」タブを廃止し、CSV 出力をここへ移植する (Refs #238, ippoan/alc-app-s3#135)
// 行クリックで開くセッション詳細 1 枚の中に動画・顔写真も表示する (Refs #238, #259, ippoan/alc-app-s3#135)

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
    global: { stubs: { MeasurementFacePhoto: true, MeasurementVideo: true } },
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

describe('TenkoSessionMonitor — 行クリックのセッション詳細に動画・顔写真を表示', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_WITH_MEASUREMENT], total: 1, page: 1, per_page: 20 })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    downloadTenkoRecordsCsvMock.mockClear()
    getMeasurementMock.mockClear()
    getMeasurementMock.mockResolvedValue({ id: 'm-1', employee_id: 'emp-1' } as any)
  })

  it('行クリックで getMeasurement(id) が呼ばれ、詳細内に MeasurementFacePhoto と MeasurementVideo が出る', async () => {
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementMock).toHaveBeenCalledWith('m-1')
    expect(wrapper.text()).toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('measurement_id が null の行をクリックしても getMeasurement は呼ばれず、2 部品も出ない', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('getMeasurement が reject するとエラー文言が出て、種別・アルコールの欄は出たまま', async () => {
    getMeasurementMock.mockRejectedValue(new Error('network error'))
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('動画・写真を取得できませんでした')
    expect(wrapper.text()).toContain('通常')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('一覧の行に「測定詳細」ボタンが無い', async () => {
    const wrapper = await mountMonitor()
    const button = wrapper.findAll('button').find(b => b.text().includes('測定詳細'))
    expect(button).toBeFalsy()
    wrapper.unmount()
  })

  it('応答前にセッション詳細を閉じる → 後から resolve しても 2 部品は出ない', async () => {
    let resolveGetMeasurement!: (v: any) => void
    getMeasurementMock.mockImplementation(() => new Promise(resolve => { resolveGetMeasurement = resolve }))
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await wrapper.vm.$nextTick()
    // 閉じる (背景クリック相当): × ボタン
    const closeButton = wrapper.findAll('button').find(b => b.text() === '×')
    await closeButton!.trigger('click')
    await wrapper.vm.$nextTick()

    resolveGetMeasurement({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('セッション詳細')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('閉じて同じ行を開き直す → 1 本目の遅れた応答で 2 本目の loading が消えず、2 本目の結果が出る', async () => {
    const resolvers: Array<(v: any) => void> = []
    getMeasurementMock.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const wrapper = await mountMonitor()

    const row = wrapper.find('tbody > tr')
    await row.trigger('click')
    await wrapper.vm.$nextTick()
    const closeButton = wrapper.findAll('button').find(b => b.text() === '×')
    await closeButton!.trigger('click')
    await wrapper.vm.$nextTick()

    await row.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('動画・写真を読み込み中…')

    // 1 本目 (古い世代) が遅れて解決しても loading は消えず、部品も出ない
    resolvers[0]!({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('動画・写真を読み込み中…')
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(false)

    // 2 本目 (今の世代) が解決すると結果が出る
    resolvers[1]!({ id: 'm-1', employee_id: 'emp-1' })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'MeasurementFacePhoto' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'MeasurementVideo' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('種別フィルタに「通常」がある', async () => {
    const wrapper = await mountMonitor()
    // 乗務員フィルタは <select> から EmployeeSearchSelect へ移したので、残る select は
    // ステータス (0) と種別 (1) の 2 つ (Refs #333)
    const options = wrapper.findAll('select')[1]!.findAll('option')
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

// 車検の列・詳細 (Refs ippoan/alc-app-s3#110)
describe('TenkoSessionMonitor — 車検の一覧・詳細', () => {
  beforeEach(() => {
    listTenkoSessionsMock.mockClear()
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
  })

  it('「車検」列のヘッダーがある', async () => {
    listTenkoSessionsMock.mockResolvedValue({ sessions: [SESSION_NORMAL], total: 1, page: 1, per_page: 20 })
    const wrapper = await mountMonitor()
    const headers = wrapper.findAll('th').map(h => h.text())
    expect(headers).toContain('車検')
    wrapper.unmount()
  })

  it('carins_matched_by が null なら列は "-" (番号を受け取っていない)', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: null, carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '未登録')
    expect(pill).toBeFalsy()
    expect(row.findAll('td').some(td => td.text() === '-')).toBe(true)
    wrapper.unmount()
  })

  it('matched_by="none" (carins に無い車) は灰 pill「未登録」', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: '000000000001', carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: 'none' }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '未登録')
    expect(pill).toBeTruthy()
    expect(pill!.classes()).toContain('bg-gray-100')
    wrapper.unmount()
  })

  it('期限切れは赤 pill「期限切れ」', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: '000000000001', carins_vehicle_id: 'TESTCARID00001', carins_expires_on: '2020-01-01', carins_matched_by: 'cert_no' }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()
    const row = wrapper.find('tbody > tr')
    const pill = row.findAll('span').find(s => s.text() === '期限切れ')
    expect(pill).toBeTruthy()
    expect(pill!.classes()).toContain('bg-red-100')
    wrapper.unmount()
  })

  it('詳細に管理番号・車両 ID・車検期限・照合を出す', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{
        ...SESSION_NORMAL,
        carins_cert_no: '000000000001',
        carins_vehicle_id: 'TESTCARID00001',
        carins_expires_on: '2030-12-31',
        carins_matched_by: 'cert_no',
      }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('000000000001')
    expect(wrapper.text()).toContain('TESTCARID00001')
    expect(wrapper.text()).toContain('2030-12-31')
    expect(wrapper.text()).toContain('管理番号')
    wrapper.unmount()
  })

  it('carins の情報が無いセッションでは詳細に「車検証」ブロックが出ない', async () => {
    listTenkoSessionsMock.mockResolvedValue({
      sessions: [{ ...SESSION_NORMAL, carins_cert_no: null, carins_vehicle_id: null, carins_expires_on: null, carins_matched_by: null }],
      total: 1, page: 1, per_page: 20,
    })
    const wrapper = await mountMonitor()

    await wrapper.find('tbody > tr').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('車検証')
    wrapper.unmount()
  })
})
