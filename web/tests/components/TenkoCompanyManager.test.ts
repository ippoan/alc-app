// 管理者の画面「点呼の届出」の事業者の表と受委託。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoCompanyManager from '~/components/TenkoCompanyManager.vue'
import { emptySettings } from '~/utils/tenko-forms'

const api = vi.hoisted(() => ({
  getTenkoOffices: vi.fn(),
  listTenkoConsignments: vi.fn(),
  createTenkoCompany: vi.fn(),
  updateTenkoCompany: vi.fn(),
  deleteTenkoCompany: vi.fn(),
  createTenkoConsignment: vi.fn(),
  updateTenkoConsignment: vi.fn(),
  deleteTenkoConsignment: vi.fn(),
  getTenkoFilingSettings: vi.fn(),
  putTenkoFilingSettings: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const O1 = 'oooooooo-0001-0001-0001-oooooooooooo'
const O2 = 'oooooooo-0002-0002-0002-oooooooooooo'
const O3 = 'oooooooo-0003-0003-0003-oooooooooooo'
const C1 = 'cccccccc-0001-0001-0001-cccccccccccc'
const C2 = 'cccccccc-0002-0002-0002-cccccccccccc'
const COMPANIES = [
  { id: C1, name: '架空運輸', is_self: true, office_ids: [O1] },
  { id: C2, name: '架空物流', is_self: false, office_ids: [O2] },
]
const CONS = [
  { id: 'k1', consignor_office_id: O1, consignee_office_id: O2, arrive_id: '20991231235959001e', permit_no: null, permit_date: null, valid_from: null, valid_to: null },
  { id: 'k2', consignor_office_id: O2, consignee_office_id: O1, arrive_id: null, permit_no: '第 99 号', permit_date: '2099-01-10', valid_from: '2099-02-01', valid_to: '2100-01-31' },
]

async function mountIt(selected = C1, companies = COMPANIES) {
  const w = await mountSuspended(TenkoCompanyManager, { props: { companies, modelValue: selected } })
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const t = (w: W, id: string) => w.find(`[data-testid="${id}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  api.getTenkoOffices.mockResolvedValue({
    offices: [
      { id: O1, name: '本社営業所' }, { id: O2, name: '港営業所' }, { id: O3, name: '予備営業所' },
    ],
    vehicles: [],
    carins_bases: [],
  })
  api.listTenkoConsignments.mockResolvedValue(CONS)
  vi.stubGlobal('confirm', vi.fn(() => true))
  api.getTenkoFilingSettings.mockImplementation(async (id: string) => (id === C1
    ? { ...emptySettings(), business_number: '000000000001', operator_postal_code: '999-0001', operator_address: '長崎県架空市1-1', operator_representative_title: '代表取締役', operator_representative: '架空　太郎', operator_phone: '000-0000-0000' }
    : emptySettings()))
  api.putTenkoFilingSettings.mockImplementation(async (_id: string, body: unknown) => body)
})

describe('TenkoCompanyManager 事業者の表', () => {
  it('名称・住所・代表者を事業者の表で入れ、書き込む値のほかの欄は残して置き換える。名称は事業者の名称と同じ', async () => {
    api.updateTenkoCompany.mockResolvedValueOnce(COMPANIES[0])
    const w = await mountIt()
    await w.findAll('[data-testid="tenko-company-edit"]')[0]!.trigger('click')
    const v = (id: string) => (t(w, id).element as HTMLInputElement).value
    expect(['business_number', 'operator_postal_code', 'operator_address', 'operator_representative_title', 'operator_representative'].map(k => v(`tenko-company-${k}`)))
      .toEqual(['000000000001', '999-0001', '長崎県架空市1-1', '代表取締役', '架空　太郎'])
    expect(t(w, 'tenko-company-business-number-hint').text()).toContain('分からなければ空欄のまま出せます')
    await t(w, 'tenko-company-operator_address').setValue(' 長崎県架空市2-2 ')
    await t(w, 'tenko-company-operator_representative_title').setValue('')
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    expect(api.putTenkoFilingSettings).toHaveBeenCalledWith(C1, {
      ...emptySettings(),
      operator_name: '架空運輸',
      business_number: '000000000001',
      operator_postal_code: '999-0001',
      operator_address: '長崎県架空市2-2',
      operator_representative_title: null,
      operator_representative: '架空　太郎',
      operator_phone: '000-0000-0000',
    })
  })

  it('事業者番号の形が違えば理由を出す', async () => {
    api.updateTenkoCompany.mockResolvedValueOnce(COMPANIES[0])
    api.putTenkoFilingSettings.mockRejectedValueOnce(new Error('400 {"error":"invalid_business_number"}'))
    const w = await mountIt()
    await w.findAll('[data-testid="tenko-company-edit"]')[0]!.trigger('click')
    await t(w, 'tenko-company-business_number').setValue('123')
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-company-error').text()).toBe('事業者番号は半角数字 12 桁で入力してください')
  })

  it('住所・代表者が読めなければ理由を出す', async () => {
    api.getTenkoFilingSettings.mockRejectedValueOnce(new Error('403 {"error":"forbidden"}'))
    const w = await mountIt()
    expect(t(w, 'tenko-company-identity-error').text()).toBe('システム管理者だけが変更できます')
    api.getTenkoFilingSettings.mockRejectedValueOnce('x')
    const w2 = await mountIt()
    expect(t(w2, 'tenko-company-identity-error').text()).toBe('事業者の住所・代表者を取得できませんでした')
  })

  it('行 = 事業者。既定の印と営業所を出し、行を選ぶと選択を知らせる。操作は文字でなくアイコン', async () => {
    const w = await mountIt()
    const rows = w.findAll('[data-testid="tenko-company-row"]')
    expect(rows.map(r => r.findAll('td').map(td => td.text()))).toEqual([['架空運輸既定', 'No.000000000001 / 〒999-0001 長崎県架空市1-1 / 代表取締役 架空　太郎', '本社営業所', ''], ['架空物流', '未入力', '港営業所', '']])
    expect(rows[0]!.classes()).toContain('bg-blue-50')
    await rows[1]!.trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([[C2]])
    for (const id of ['tenko-company-edit', 'tenko-company-delete']) {
      const b = rows[0]!.find(`[data-testid="${id}"]`)
      expect([b.text(), b.find('svg').exists(), b.attributes('aria-label')]).toEqual(['', true, b.attributes('title')])
    }
  })

  it('事業者が無ければ案内を出し、営業所の読み込みに失敗したら理由を出す', async () => {
    const none = await mountIt('', [])
    expect(t(none, 'tenko-company-empty').exists()).toBe(true)
    expect(t(none, 'tenko-consignments').exists()).toBe(false)
    api.getTenkoOffices.mockRejectedValueOnce(new Error('403 {"error":"forbidden"}'))
    const bad = await mountIt()
    expect(t(bad, 'tenko-company-load-error').text()).toBe('システム管理者だけが変更できます')
    api.getTenkoOffices.mockRejectedValueOnce('x')
    const bad2 = await mountIt()
    expect(t(bad2, 'tenko-company-load-error').text()).toBe('営業所・受委託を取得できませんでした')
  })

  it('追加: 最初の 1 件は既定にし、保存すると作った事業者を選ぶ。営業所は送らず、営業所の画面で選ぶと添える', async () => {
    api.createTenkoCompany.mockResolvedValue({ id: 'new', name: '架空商事', is_self: false, office_ids: [] })
    const none = await mountIt('', [])
    await t(none, 'tenko-company-add').trigger('click')
    expect((t(none, 'tenko-company-is-self').element as HTMLInputElement).checked).toBe(true)

    const w = await mountIt()
    await t(w, 'tenko-company-add').trigger('click')
    expect((t(w, 'tenko-company-is-self').element as HTMLInputElement).checked).toBe(false)
    await t(w, 'tenko-company-name').setValue(' 架空商事 ')
    expect(w.find('[data-testid="tenko-company-office"]').exists()).toBe(false)
    expect(t(w, 'tenko-company-offices-list').text()).toBe('営業所なし')
    expect(t(w, 'tenko-company-offices').text()).toContain('下の営業所の表で選びます')
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    expect(api.createTenkoCompany).toHaveBeenCalledWith({ name: '架空商事', is_self: false })
    expect(api.putTenkoFilingSettings).toHaveBeenCalledWith('new', { ...emptySettings(), operator_name: '架空商事' })
    expect(w.emitted('update:modelValue')).toEqual([['new']])
    expect(w.emitted('changed')).toHaveLength(1)
    expect(t(w, 'tenko-company-form').exists()).toBe(false)
    expect(api.getTenkoOffices).toHaveBeenCalledTimes(3)
  })

  it('編集: 名称・既定・営業所を置き換える (選びは変えない)。失敗は理由を出し、やめるで閉じる', async () => {
    api.updateTenkoCompany.mockRejectedValueOnce(new Error('400 {"error":"duplicate_name"}'))
    const w = await mountIt()
    await w.findAll('[data-testid="tenko-company-edit"]')[1]!.trigger('click')
    expect((t(w, 'tenko-company-name').element as HTMLInputElement).value).toBe('架空物流')
    expect(t(w, 'tenko-company-offices-list').text()).toBe('港営業所')
    await t(w, 'tenko-company-is-self').setValue(true)
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-company-error').text()).toBe('同じ名称の事業者がすでにあります')
    api.updateTenkoCompany.mockResolvedValueOnce(COMPANIES[1])
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    // 営業所の振り分けは今のまま送る (省くとサーバーが外す)
    expect(api.updateTenkoCompany).toHaveBeenLastCalledWith(C2, { name: '架空物流', is_self: true, office_ids: [O2] })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await w.findAll('[data-testid="tenko-company-edit"]')[0]!.trigger('click')
    await t(w, 'tenko-company-cancel').trigger('click')
    expect(t(w, 'tenko-company-form').exists()).toBe(false)
    api.updateTenkoCompany.mockRejectedValueOnce(null)
    await w.findAll('[data-testid="tenko-company-edit"]')[0]!.trigger('click')
    await t(w, 'tenko-company-save').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-company-error').text()).toBe('保存できませんでした')
  })

  it('削除は確かめてから。やめれば何もせず、失敗は理由を出し、編集中の事業者を消したら編集欄も閉じる', async () => {
    const w = await mountIt()
    const del = () => w.findAll('[data-testid="tenko-company-delete"]')[1]!.trigger('click')
    vi.mocked(confirm).mockReturnValueOnce(false)
    await del()
    expect(api.deleteTenkoCompany).not.toHaveBeenCalled()
    api.deleteTenkoCompany.mockRejectedValueOnce(new Error('404 x'))
    await del()
    await flushPromises()
    expect(t(w, 'tenko-company-table-error').text()).toContain('404')
    await w.findAll('[data-testid="tenko-company-edit"]')[1]!.trigger('click')
    await del()
    await flushPromises()
    expect(api.deleteTenkoCompany).toHaveBeenLastCalledWith(C2)
    expect(t(w, 'tenko-company-form').exists()).toBe(false)
    expect(w.emitted('changed')).toHaveLength(1)
    await w.findAll('[data-testid="tenko-company-edit"]')[0]!.trigger('click')
    await del()
    await flushPromises()
    expect(t(w, 'tenko-company-form').exists()).toBe(true)
  })
})

describe('TenkoCompanyManager 受委託', () => {
  const row = (w: W) => w.findAll('[data-testid="tenko-consignment-row"]').map(r => r.findAll('td').map(td => td.text().replace(/\s+/g, ' ')).slice(0, 6))

  it('委託・受託のどちらかが選んだ事業者の営業所なら出す (両方の事業者から見える)。許可番号が空なら「申請中」', async () => {
    const expected = [
      ['本社営業所 (架空運輸)', '港営業所 (架空物流)', '20991231235959001e', '申請中', '-', '-'],
      ['港営業所 (架空物流)', '本社営業所 (架空運輸)', '-', '第 99 号', '2099-01-10', '2099-02-01 〜 2100-01-31'],
    ]
    expect(row(await mountIt(C1))).toEqual(expected)
    expect(row(await mountIt(C2))).toEqual(expected)
  })

  it('選んだ事業者の営業所が入っていない受委託は出さない', async () => {
    api.listTenkoConsignments.mockResolvedValue([{ ...CONS[0], consignee_office_id: O3 }])
    const w = await mountIt(C2)
    expect(row(w)).toEqual([])
    expect(t(w, 'tenko-consignment-empty').exists()).toBe(true)
    api.listTenkoConsignments.mockResolvedValue([{ ...CONS[0], consignor_office_id: O3, consignee_office_id: O3 }])
    expect(row(await mountIt(C1))).toEqual([])
  })

  it('追加: 委託は選んだ事業者の営業所から。空の欄は null で送り、成功したら読み直す', async () => {
    api.createTenkoConsignment.mockResolvedValue(CONS[0])
    const w = await mountIt()
    await t(w, 'tenko-consignment-add').trigger('click')
    expect((t(w, 'tenko-consignment-consignor').element as HTMLSelectElement).value).toBe(O1)
    expect(t(w, 'tenko-consignment-consignee').findAll('option').map(o => o.text())).toEqual(['選んでください', '本社営業所 (架空運輸)', '港営業所 (架空物流)'])
    await t(w, 'tenko-consignment-consignee').setValue(O2)
    await t(w, 'tenko-consignment-arrive').setValue(' 20991231235959001e ')
    await t(w, 'tenko-consignment-save').trigger('click')
    await flushPromises()
    expect(api.createTenkoConsignment).toHaveBeenCalledWith({
      consignor_office_id: O1, consignee_office_id: O2, arrive_id: '20991231235959001e', permit_no: null, permit_date: null, valid_from: null, valid_to: null,
    })
    expect(t(w, 'tenko-consignment-form').exists()).toBe(false)
    expect(api.listTenkoConsignments).toHaveBeenCalledTimes(2)
  })

  it('営業所を持たない事業者でも追加の欄は開ける (委託は未選択)', async () => {
    const w = await mountIt(C1, [{ ...COMPANIES[0]!, office_ids: [] }, COMPANIES[1]!])
    await t(w, 'tenko-consignment-add').trigger('click')
    expect((t(w, 'tenko-consignment-consignor').element as HTMLSelectElement).value).toBe('')
  })

  it('編集: 許可番号・許可日・期間を入れて置き換える。検めの失敗は理由を出す', async () => {
    const w = await mountIt()
    await w.findAll('[data-testid="tenko-consignment-edit"]')[0]!.trigger('click')
    expect((t(w, 'tenko-consignment-arrive').element as HTMLInputElement).value).toBe('20991231235959001e')
    await t(w, 'tenko-consignment-permit-no').setValue('第 1 号')
    await t(w, 'tenko-consignment-permit-date').setValue('2099-03-01')
    await t(w, 'tenko-consignment-valid-from').setValue('2099-03-01')
    api.updateTenkoConsignment.mockRejectedValueOnce(new Error('400 {"error":"invalid_period"}'))
    await t(w, 'tenko-consignment-save').trigger('click')
    await flushPromises()
    expect(t(w, 'tenko-consignment-error').text()).toContain('期間は開始日と終了日を両方入れ')
    await t(w, 'tenko-consignment-valid-to').setValue('2100-02-28')
    api.updateTenkoConsignment.mockResolvedValueOnce(CONS[0])
    await t(w, 'tenko-consignment-save').trigger('click')
    await flushPromises()
    expect(api.updateTenkoConsignment).toHaveBeenLastCalledWith('k1', {
      consignor_office_id: O1, consignee_office_id: O2, arrive_id: '20991231235959001e', permit_no: '第 1 号', permit_date: '2099-03-01', valid_from: '2099-03-01', valid_to: '2100-02-28',
    })
    await w.findAll('[data-testid="tenko-consignment-edit"]')[1]!.trigger('click')
    expect((t(w, 'tenko-consignment-valid-to').element as HTMLInputElement).value).toBe('2100-01-31')
    await t(w, 'tenko-consignment-cancel').trigger('click')
    expect(t(w, 'tenko-consignment-form').exists()).toBe(false)
  })

  it('削除は確かめてから。失敗は理由を出し、編集中の受委託を消したら編集欄も閉じる', async () => {
    const w = await mountIt()
    const del = (i: number) => w.findAll('[data-testid="tenko-consignment-delete"]')[i]!.trigger('click')
    vi.mocked(confirm).mockReturnValueOnce(false)
    await del(0)
    expect(api.deleteTenkoConsignment).not.toHaveBeenCalled()
    api.deleteTenkoConsignment.mockRejectedValueOnce(new Error('404 x'))
    await del(0)
    await flushPromises()
    expect(t(w, 'tenko-consignment-table-error').text()).toContain('404')
    await w.findAll('[data-testid="tenko-consignment-edit"]')[0]!.trigger('click')
    await del(0)
    await flushPromises()
    expect(api.deleteTenkoConsignment).toHaveBeenLastCalledWith('k1')
    expect(t(w, 'tenko-consignment-form').exists()).toBe(false)
    await w.findAll('[data-testid="tenko-consignment-edit"]')[0]!.trigger('click')
    await del(1)
    await flushPromises()
    expect(t(w, 'tenko-consignment-form').exists()).toBe(true)
  })

  it('消えた営業所は名前の代わりに印を出す', async () => {
    api.listTenkoConsignments.mockResolvedValue([{ ...CONS[0], consignee_office_id: 'gone' }])
    expect(row(await mountIt())[0]![1]).toBe('(消えた営業所)')
  })
})
