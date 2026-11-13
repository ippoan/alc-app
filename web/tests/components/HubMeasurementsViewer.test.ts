import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HubMeasurementsViewer from '~/components/HubMeasurementsViewer.vue'
import { resetDeviceNames } from '~/composables/useDeviceNames'

// 点呼タブ (システム管理者「点呼」) から測定詳細を開く (Refs #238, ippoan/alc-app-s3#135)。
// hub_measurements には PC 側の measurements への直接のキーが無いので、
// 「同じ乗務員・近い時刻」で getMeasurements を検索して当てる。

const listHubMeasurementsMock = vi.fn(async () => ({ items: [] as any[], limit: 50, offset: 0, has_more: false }))
const getEmployeesMock = vi.fn(async () => [] as any[])
const getMeasurementsMock = vi.fn(async () => ({ measurements: [] as any[], total: 0, page: 1, per_page: 20 }))
const fetchFacePhotoMock = vi.fn(async () => null as string | null)
const fetchMeasurementVideoMock = vi.fn(async () => null as string | null)
const listCamHostKeysMock = vi.fn(async () => ({ keys: [] as any[], names: [] as any[] }))
const listDeviceLabelsMock = vi.fn(async () => ({ devices: [] as any[] }))

vi.mock('~/utils/api', () => ({
  listHubMeasurements: (...args: any[]) => listHubMeasurementsMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
  getMeasurements: (...args: any[]) => getMeasurementsMock(...args),
  fetchFacePhoto: (...args: any[]) => fetchFacePhotoMock(...args),
  fetchMeasurementVideo: (...args: any[]) => fetchMeasurementVideoMock(...args),
  listCamHostKeys: () => listCamHostKeysMock(),
  listDeviceLabels: () => listDeviceLabelsMock(),
}))

/** onMounted の await 群を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const EMPLOYEE = { id: 'emp-1', tenant_id: 't-1', nfc_id: 'nfc-1', name: '山田太郎', role: ['driver'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }

/** 乗務員が引ける行 (免許証あり、nfc_id が employee と一致)。 */
const ROW_WITH_EMPLOYEE = {
  id: 'hm-1', tenant_id: 't-1', device_id: 'dev-1', kind: 'license', seq: 1,
  session_id: 's-1', recorded_at: '2026-09-12T00:33:00.000Z', created_at: '2026-09-12T00:33:00.000Z',
  payload: { nfc_id: 'nfc-1', issue: '20200101', expiry: '20300101' },
}

/** 乗務員が引けない行 (免許証タップ無し = 単発のアルコール測定)。 */
const ROW_WITHOUT_EMPLOYEE = {
  id: 'hm-2', tenant_id: 't-1', device_id: 'dev-1', kind: 'alcohol', seq: 1,
  session_id: 's-2', recorded_at: '2026-09-12T01:00:00.000Z', created_at: '2026-09-12T01:00:00.000Z',
  payload: { value: 0.1, result: 'normal' },
}

function apiMeasurement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-near', tenant_id: 't-1', employee_id: 'emp-1', alcohol_value: 0.1, result_type: 'normal',
    device_use_count: 1, measured_at: '2026-09-12T00:33:00.000Z', created_at: '2026-09-12T00:33:00.000Z',
    updated_at: '2026-09-12T00:33:00.000Z', status: 'completed',
    ...overrides,
  }
}

async function mountViewer() {
  const wrapper = await mountSuspended(HubMeasurementsViewer)
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('HubMeasurementsViewer — 点呼タブから測定詳細を開く', () => {
  beforeEach(() => {
    listHubMeasurementsMock.mockClear()
    listHubMeasurementsMock.mockResolvedValue({ items: [ROW_WITH_EMPLOYEE, ROW_WITHOUT_EMPLOYEE], limit: 50, offset: 0, has_more: false })
    getEmployeesMock.mockClear()
    getEmployeesMock.mockResolvedValue([EMPLOYEE])
    getMeasurementsMock.mockClear()
    getMeasurementsMock.mockResolvedValue({ measurements: [], total: 0, page: 1, per_page: 20 })
    fetchFacePhotoMock.mockClear()
    fetchMeasurementVideoMock.mockClear()
  })

  it('乗務員が引けた行にだけ「測定詳細」ボタンを出す', async () => {
    const wrapper = await mountViewer()
    const rows = wrapper.findAll('tbody > tr').filter(tr => !tr.text().includes('端末計時'))
    expect(rows).toHaveLength(2)
    const buttonTexts = (tr: typeof rows[number]) => tr.findAll('button').map(b => b.text())

    expect(buttonTexts(rows[0]!)).toContain('測定詳細')
    expect(buttonTexts(rows[1]!)).not.toContain('測定詳細')
    wrapper.unmount()
  })

  it('一覧の読み込み時には getMeasurements を呼ばない (行ごとの N+1 を作らない)', async () => {
    await mountViewer()
    expect(getMeasurementsMock).not.toHaveBeenCalled()
  })

  it('押すと employee_id と ±15 分の ISO (UTC) で getMeasurements が 1 回呼ばれ、いちばん近い測定で開く', async () => {
    const near = apiMeasurement({ id: 'm-near', measured_at: '2026-09-12T00:30:00.000Z', alcohol_value: 0.111 })
    const far = apiMeasurement({ id: 'm-far', measured_at: '2026-09-12T00:20:00.000Z', alcohol_value: 0.222 })
    getMeasurementsMock.mockResolvedValueOnce({ measurements: [far, near], total: 2, page: 1, per_page: 20 })

    const wrapper = await mountViewer()
    const rows = wrapper.findAll('tbody > tr').filter(tr => !tr.text().includes('端末計時'))
    const btn = rows[0]!.findAll('button').find(b => b.text() === '測定詳細')!
    await btn.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(getMeasurementsMock).toHaveBeenCalledTimes(1)
    expect(getMeasurementsMock).toHaveBeenCalledWith({
      employee_id: 'emp-1',
      date_from: '2026-09-12T00:18:00.000Z',
      date_to: '2026-09-12T00:48:00.000Z',
    })
    // いちばん近い (誤差 3 分) 側の測定値が開く
    expect(wrapper.text()).toContain('0.111')
    expect(wrapper.text()).not.toContain('0.222')
    wrapper.unmount()
  })

  it('取得中はボタンを disabled にする', async () => {
    let resolveFn: ((v: any) => void) | undefined
    getMeasurementsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFn = resolve }))
    const wrapper = await mountViewer()
    const rows = wrapper.findAll('tbody > tr').filter(tr => !tr.text().includes('端末計時'))
    const btn = rows[0]!.findAll('button').find(b => b.text() === '測定詳細' || b.text() === '検索中…')!
    await btn.trigger('click')
    await wrapper.vm.$nextTick()

    const btnAfter = rows[0]!.findAll('button').find(b => b.text() === '検索中…')!
    expect(btnAfter.attributes('disabled')).toBeDefined()

    resolveFn!({ measurements: [], total: 0, page: 1, per_page: 20 })
    await flush()
    wrapper.unmount()
  })

  it('0 件なら「この点呼に対応する測定が見つかりません」を行内に出す', async () => {
    getMeasurementsMock.mockResolvedValueOnce({ measurements: [], total: 0, page: 1, per_page: 20 })
    const wrapper = await mountViewer()
    const rows = wrapper.findAll('tbody > tr').filter(tr => !tr.text().includes('端末計時'))
    const btn = rows[0]!.findAll('button').find(b => b.text() === '測定詳細')!
    await btn.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(rows[0]!.text()).toContain('この点呼に対応する測定が見つかりません')
    wrapper.unmount()
  })

  it('失敗したら「測定を取得できませんでした」を行内に出す', async () => {
    getMeasurementsMock.mockRejectedValueOnce(new Error('network error'))
    const wrapper = await mountViewer()
    const rows = wrapper.findAll('tbody > tr').filter(tr => !tr.text().includes('端末計時'))
    const btn = rows[0]!.findAll('button').find(b => b.text() === '測定詳細')!
    await btn.trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(rows[0]!.text()).toContain('測定を取得できませんでした')
    wrapper.unmount()
  })
})

describe('HubMeasurementsViewer — 端末は名前 (ID はツールチップ)', () => {
  const NAMES = [
    { device_id: 'alarm:fp-1', label: '事務所の機体', revoked: false },
    { device_id: 'alarm:old', label: '旧機', revoked: true },
    { device_id: 'alarm:nolabel', label: null, revoked: false },
  ]

  beforeEach(() => {
    resetDeviceNames()
    listHubMeasurementsMock.mockClear()
    getEmployeesMock.mockResolvedValue([])
    listCamHostKeysMock.mockResolvedValue({ keys: [], names: NAMES })
    listDeviceLabelsMock.mockResolvedValue({ devices: [{ device_id: 'dev-1', label: '旧ハブ' }] })
  })

  it('★ 「端末」列は machine_id (鍵に畳んだ ID) から引いた名前。ID は title。machine_id が無い古い応答は device_id から引く', async () => {
    listHubMeasurementsMock.mockResolvedValue({
      items: [
        { ...ROW_WITHOUT_EMPLOYEE, id: 'a', session_id: 'sa', device_id: 'cores3-a', via_device_id: 'cores3-a', machine_id: 'alarm:fp-1' },
        { ...ROW_WITHOUT_EMPLOYEE, id: 'b', session_id: 'sb', device_id: 'dev-1' },
        { ...ROW_WITHOUT_EMPLOYEE, id: 'c', session_id: 'sc', device_id: 'dev-9', machine_id: null },
      ],
      limit: 50, offset: 0, has_more: false,
    })
    const wrapper = await mountViewer()
    const cells = wrapper.findAll('[data-testid="hub-device"]')
    expect(cells.map(c => c.text())).toEqual(['事務所の機体', '旧ハブ (鍵の ID 未登録)', '名前未登録の端末'])
    expect(cells.map(c => c.attributes('title'))).toEqual(['alarm:fp-1', 'dev-1', 'dev-9'])
    wrapper.unmount()
  })

  it('★ 絞り込みは名前の選択肢 (中身は鍵の ID)。選んで検索すると鍵の ID で絞る。名前が無い鍵・鍵でない ID は選択肢に出ない', async () => {
    listHubMeasurementsMock.mockResolvedValue({ items: [], limit: 50, offset: 0, has_more: false })
    const wrapper = await mountViewer()
    const select = wrapper.find('[data-testid="hub-device-filter"]')
    expect(select.findAll('option').map(o => [o.attributes('value'), o.text()])).toEqual([
      ['', 'すべて'], ['alarm:fp-1', '事務所の機体'], ['alarm:old', '旧機 (失効)'],
    ])
    await select.setValue('alarm:fp-1')
    await wrapper.findAll('button').find(b => b.text() === '検索')!.trigger('click')
    await flush()
    expect(listHubMeasurementsMock).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: 'alarm:fp-1' }))
    await wrapper.findAll('button').find(b => b.text() === '条件クリア')!.trigger('click')
    await flush()
    expect(listHubMeasurementsMock).toHaveBeenLastCalledWith(expect.objectContaining({ device_id: undefined }))
    wrapper.unmount()
  })

  it('名前の表が取れなくても一覧は出る (選択肢は「すべて」だけ・名前は名前未登録の端末)', async () => {
    listCamHostKeysMock.mockRejectedValue(new Error('403'))
    listDeviceLabelsMock.mockRejectedValue(new Error('403'))
    listHubMeasurementsMock.mockResolvedValue({ items: [{ ...ROW_WITHOUT_EMPLOYEE, machine_id: 'alarm:fp-1' }], limit: 50, offset: 0, has_more: false })
    const wrapper = await mountViewer()
    expect(wrapper.find('[data-testid="hub-device-filter"]').findAll('option')).toHaveLength(1)
    expect(wrapper.find('[data-testid="hub-device"]').text()).toBe('名前未登録の端末')
    wrapper.unmount()
  })
})

describe('HubMeasurementsViewer — 点呼の区分と実施場所', () => {
  beforeEach(() => {
    getEmployeesMock.mockResolvedValue([EMPLOYEE])
    listHubMeasurementsMock.mockResolvedValue({
      items: [
        // 同じ点呼: 免許証の行には点呼が結ばれず、アルコールの行に結ばれている
        { ...ROW_WITH_EMPLOYEE, id: 'hm-a', kind: 'alcohol', payload: { value: 0, result: 'normal' }, tenko_method: 'IT点呼', manager_judgment_method: 'in_person', tenko_location: '本社営業所' },
        // 同じ点呼の古い測定に別の点呼が結ばれていても、新しい方 (先に来る行) を採る
        { ...ROW_WITH_EMPLOYEE, id: 'hm-b', kind: 'temperature', payload: { value: 36.5 }, tenko_method: '遠隔点呼', tenko_location: '別営業所' },
        ROW_WITH_EMPLOYEE,
        { ...ROW_WITHOUT_EMPLOYEE, tenko_method: 'IT点呼', manager_judgment_method: 'it', tenko_location: null },
        { ...ROW_WITHOUT_EMPLOYEE, id: 'hm-3', session_id: 's-3' },
      ],
      limit: 50, offset: 0, has_more: false,
    })
  })

  it('★ 束ねた測定のどれかに結ばれた点呼の区分 (IT点呼を対面で確定したら対面点呼) と実施場所を出す。無ければ —', async () => {
    const wrapper = await mountSuspended(HubMeasurementsViewer, { props: { scope: 'tenko' } })
    await flush()
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('thead th').map(th => th.text())).toEqual(expect.arrayContaining(['区分', '実施場所']))
    expect(wrapper.findAll('[data-testid="hub-tenko-method"]').map(td => td.text())).toEqual(['対面点呼', 'IT点呼', '—'])
    expect(wrapper.findAll('[data-testid="hub-tenko-location"]').map(td => td.text())).toEqual(['本社営業所', '—', '—'])
  })

  it('打刻タブ (scope=timecard) には区分・実施場所の列を出さない', async () => {
    const wrapper = await mountSuspended(HubMeasurementsViewer, { props: { scope: 'timecard' } })
    await flush()
    await wrapper.vm.$nextTick()
    const heads = wrapper.findAll('thead th').map(th => th.text())
    expect(heads).not.toContain('区分')
    expect(heads).not.toContain('実施場所')
  })

  it('JSON を開いた行は列数ぶん colspan を取る', async () => {
    for (const [scope, span] of [['tenko', '10'], ['timecard', '9'], ['all', '11']] as const) {
      const wrapper = await mountSuspended(HubMeasurementsViewer, { props: { scope } })
      await flush()
      await wrapper.vm.$nextTick()
      await wrapper.find('tbody button').trigger('click')
      expect(wrapper.find('td[colspan]').attributes('colspan')).toBe(span)
    }
  })
})

describe('HubMeasurementsViewer — 点呼まで進まなかった回は「未完了」と理由', () => {
  beforeEach(() => {
    getEmployeesMock.mockResolvedValue([EMPLOYEE])
    listHubMeasurementsMock.mockResolvedValue({
      items: [
        // ① アルコールは届いたが測定が started のまま (2026-11-13 4:10 の実例)
        { ...ROW_WITHOUT_EMPLOYEE, id: 'u-1', session_id: 'u1', measurement_status: 'started' },
        // ② 体温だけで止まった
        { ...ROW_WITHOUT_EMPLOYEE, id: 'u-2', session_id: 'u2', kind: 'temperature', payload: { value: 36.8 }, measurement_status: 'started' },
        // ③ 完了して点呼もある
        { ...ROW_WITHOUT_EMPLOYEE, id: 'u-3', session_id: 'u3', measurement_status: 'completed', tenko_method: '通常点呼', tenko_location: '釧路営業所' },
        // ④ 完了したが点呼が無い / ⑤ 測定に結ばれない
        { ...ROW_WITHOUT_EMPLOYEE, id: 'u-4', session_id: 'u4', measurement_status: 'completed' },
        { ...ROW_WITH_EMPLOYEE, id: 'u-5', session_id: 'u5' },
      ],
      limit: 50, offset: 0, has_more: false,
    })
  })

  it('★ 測定が完了していない回は「未完了」とどこで止まったかを出す。完了・結ばれない行は従来どおり', async () => {
    const wrapper = await mountSuspended(HubMeasurementsViewer, { props: { scope: 'tenko' } })
    await flush()
    await wrapper.vm.$nextTick()
    const cells = wrapper.findAll('[data-testid="hub-tenko-method"]').map(td => td.text())
    expect(cells[0]).toBe('未完了アルコールは測ったが、画面で点呼が保存されていない')
    expect(cells[1]).toBe('未完了アルコールを測る前に止まった')
    expect(cells.slice(2)).toEqual(['通常点呼', '—', '—'])
    expect(wrapper.findAll('[data-testid="hub-tenko-incomplete-reason"]')).toHaveLength(2)
  })
})
