import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HubMeasurementsViewer from '~/components/HubMeasurementsViewer.vue'

// 点呼タブ (システム管理者「点呼」) から測定詳細を開く (Refs #238, ippoan/alc-app-s3#135)。
// hub_measurements には PC 側の measurements への直接のキーが無いので、
// 「同じ乗務員・近い時刻」で getMeasurements を検索して当てる。

const listHubMeasurementsMock = vi.fn(async () => ({ items: [] as any[], limit: 50, offset: 0, has_more: false }))
const getEmployeesMock = vi.fn(async () => [] as any[])
const getMeasurementsMock = vi.fn(async () => ({ measurements: [] as any[], total: 0, page: 1, per_page: 20 }))
const fetchFacePhotoMock = vi.fn(async () => null as string | null)
const fetchMeasurementVideoMock = vi.fn(async () => null as string | null)

vi.mock('~/utils/api', () => ({
  listHubMeasurements: (...args: any[]) => listHubMeasurementsMock(...args),
  getEmployees: (...args: any[]) => getEmployeesMock(...args),
  getMeasurements: (...args: any[]) => getMeasurementsMock(...args),
  fetchFacePhoto: (...args: any[]) => fetchFacePhotoMock(...args),
  fetchMeasurementVideo: (...args: any[]) => fetchMeasurementVideoMock(...args),
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
