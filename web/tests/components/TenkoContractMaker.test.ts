// 管理者の画面「点呼の届出」の受委託の契約書の欄。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoContractMaker from '~/components/TenkoContractMaker.vue'
import { emptySettings } from '~/utils/tenko-forms'

const api = vi.hoisted(() => ({
  getTenkoOffices: vi.fn(),
  listTenkoConsignments: vi.fn(),
  getTenkoFilingSettings: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))
const contract = vi.hoisted(() => ({ buildContracts: vi.fn() }))
vi.mock('~/utils/consignment-contract', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/consignment-contract')>()),
  ...contract,
}))
const forms = vi.hoisted(() => ({ saveBytes: vi.fn() }))
vi.mock('~/utils/tenko-forms', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/tenko-forms')>()),
  ...forms,
}))

const C1 = 'cccccccc-0001-0001-0001-cccccccccccc'
const C2 = 'cccccccc-0002-0002-0002-cccccccccccc'
const COMPANIES = [
  { id: C1, name: '架空運輸', is_self: true, office_ids: ['o1', 'o2'] },
  { id: C2, name: '架空物流', is_self: false, office_ids: ['o3', 'o4'] },
]
const OFFICES = [
  { id: 'o1', name: '港営業所', company_id: C1, address: '長崎県架空市' },
  { id: 'o2', name: '本社 (長崎)', company_id: C1, address: '長崎県架空市' },
  { id: 'o3', name: '本社', company_id: C2, address: '北海道架空市' },
  { id: 'o4', name: '釧路営業所', company_id: C2, address: '北海道釧路市' },
]

async function mountIt(companies = COMPANIES) {
  const w = await mountSuspended(TenkoContractMaker, { props: { companies } })
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const t = (w: W, id: string) => w.find(`[data-testid="${id}"]`)
const val = (w: W, id: string) => (t(w, id).element as HTMLInputElement).value

beforeEach(() => {
  vi.clearAllMocks()
  api.getTenkoOffices.mockResolvedValue({ offices: OFFICES, vehicles: [], carins_bases: [] })
  api.listTenkoConsignments.mockResolvedValue([
    { id: 'k1', consignor_office_id: 'o2', consignee_office_id: 'o3', arrive_id: null, permit_no: null, permit_date: null, valid_from: '2027-02-01', valid_to: '2032-01-31' },
    { id: 'k2', consignor_office_id: 'o3', consignee_office_id: 'o2', arrive_id: null, permit_no: null, permit_date: null, valid_from: null, valid_to: null },
  ])
  api.getTenkoFilingSettings.mockImplementation(async (id: string) => ({
    ...emptySettings(),
    operator_name: id === C1 ? '架空運輸' : '架空物流',
    operator_address: id === C1 ? '長崎県架空市' : '',
    operator_representative: '架空　太郎',
  }))
  contract.buildContracts.mockResolvedValue({ bytes: new Uint8Array([1]), filename: 'k.zip' })
})

describe('TenkoContractMaker', () => {
  it('甲は先頭・乙は別の事業者、営業所は本社が既定。受委託の期間と乙の運輸局を入れる', async () => {
    const w = await mountIt()
    expect([val(w, 'tenko-contract-kou-company'), val(w, 'tenko-contract-otsu-company')]).toEqual([C1, C2])
    expect([val(w, 'tenko-contract-kou-office'), val(w, 'tenko-contract-otsu-office')]).toEqual(['o2', 'o3'])
    expect(t(w, 'tenko-contract-kou-office').findAll('option').map(o => o.text())).toEqual(['港営業所', '本社 (長崎)'])
    expect([val(w, 'tenko-contract-from'), val(w, 'tenko-contract-to'), val(w, 'tenko-contract-bureau')])
      .toEqual(['2027-02-01', '2032-01-31', '北海道運輸局長'])
    expect(t(w, 'tenko-contract-problem').exists()).toBe(false)
    expect(t(w, 'tenko-contract-bureau').findAll('option').map(o => o.text())).toContain('沖縄総合事務局長')
  })

  it('選んだ営業所で雛形を埋めて保存し、足りない値を知らせる。運輸局が空なら乙の住所から', async () => {
    const w = await mountIt()
    await t(w, 'tenko-contract-otsu-office').setValue('o4')
    await t(w, 'tenko-contract-bureau').setValue('')
    await t(w, 'tenko-contract-download').trigger('click')
    await flushPromises()
    const req = contract.buildContracts.mock.calls[0]![0]
    expect([req.kou.office, req.otsu.office, req.validFrom, req.validTo, req.bureau])
      .toEqual(['本社営業所', '釧路営業所', '2027-02-01', '2032-01-31', ''])
    expect(forms.saveBytes).toHaveBeenCalledWith(new Uint8Array([1]), 'k.zip', 'zip')
    // 入れ替えた向きの運輸局長は、甲の営業所 (長崎) の管轄
    expect(contract.buildContracts.mock.calls[0]![1]).toBe('九州運輸局長')
    expect(t(w, 'tenko-contract-missing').text()).toContain('乙の住所')
    await t(w, 'tenko-contract-bureau').setValue('九州運輸局長')
    await t(w, 'tenko-contract-download').trigger('click')
    await flushPromises()
    expect(contract.buildContracts.mock.calls[1]![0].bureau).toBe('九州運輸局長')
  })

  it('書き込む値の名称が空なら事業者の表の名称を書く', async () => {
    api.getTenkoFilingSettings.mockResolvedValue(emptySettings())
    const w = await mountIt()
    await t(w, 'tenko-contract-download').trigger('click')
    await flushPromises()
    const req = contract.buildContracts.mock.calls[0]![0]
    expect([req.kou.settings.operator_name, req.otsu.settings.operator_name]).toEqual(['架空運輸', '架空物流'])
  })

  it('開始日を入れると終了日を 5 年にする。終了日は後から直せる', async () => {
    const w = await mountIt()
    await t(w, 'tenko-contract-from').setValue('2028-04-01')
    expect(val(w, 'tenko-contract-to')).toBe('2033-03-31')
    await t(w, 'tenko-contract-to').setValue('2030-03-31')
    expect(val(w, 'tenko-contract-to')).toBe('2030-03-31')
    expect(val(w, 'tenko-contract-from')).toBe('2028-04-01')
  })

  it('作れなければ理由を出す (理由が無ければ決まり文句)', async () => {
    const w = await mountIt()
    contract.buildContracts.mockRejectedValueOnce(new Error('契約書の雛形を取得できませんでした (404)'))
    await t(w, 'tenko-contract-download').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-contract-error').text()).toBe('契約書の雛形を取得できませんでした (404)')
    contract.buildContracts.mockRejectedValueOnce('x')
    await t(w, 'tenko-contract-download').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-contract-error').text()).toBe('契約書を作成できませんでした')
  })

  it('選び方が足りなければボタンを止めて理由を出す', async () => {
    const w = await mountIt()
    await t(w, 'tenko-contract-to').setValue('2026-01-01')
    expect(t(w, 'tenko-contract-problem').text()).toContain('期間は')
    expect(t(w, 'tenko-contract-download').attributes('disabled')).toBeDefined()
    await t(w, 'tenko-contract-otsu-company').setValue(C1)
    expect(t(w, 'tenko-contract-problem').text()).toBe('委託と受託は別の事業者にしてください')
    api.getTenkoOffices.mockResolvedValueOnce({ offices: [], vehicles: [], carins_bases: [] })
    const none = await mountIt()
    expect(t(none, 'tenko-contract-problem').text()).toContain('営業所を選んでください')
    const one = await mountIt([COMPANIES[0]!])
    expect(t(one, 'tenko-contract-problem').text()).toBe('委託と受託の事業者を選んでください')
  })

  it('営業所が読めなければ理由を出す', async () => {
    api.getTenkoOffices.mockRejectedValueOnce(new Error('x'))
    const w = await mountIt()
    expect(t(w, 'tenko-contract-load-error').text()).toBe('営業所・受委託を取得できませんでした')
  })
})
