// 管理者の画面のタブ「点呼の届出」。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { strToU8, zipSync } from 'fflate'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoFilingManager from '~/components/TenkoFilingManager.vue'
import { emptySettings, type FilingSettings } from '~/utils/tenko-forms'

const api = vi.hoisted(() => ({
  getTenkoFilingSettings: vi.fn(),
  putTenkoFilingSettings: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))
const forms = vi.hoisted(() => ({
  buildFilledForm: vi.fn(),
  saveBytes: vi.fn(),
  fetchProductInfo: vi.fn(),
}))
vi.mock('~/utils/tenko-forms', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/tenko-forms')>()),
  ...forms,
}))

function saved(over: Partial<FilingSettings> = {}): FilingSettings {
  return { ...emptySettings(), business_number: '000000000001', updated_at: '2026-11-02T00:00:00Z', ...over }
}

async function mountIt(s: FilingSettings | Error = saved()) {
  if (s instanceof Error) api.getTenkoFilingSettings.mockRejectedValue(s)
  else api.getTenkoFilingSettings.mockResolvedValue(s)
  const w = await mountSuspended(TenkoFilingManager)
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const dlButtons = (w: W) => w.findAll('[data-testid^="tenko-filing-dl-"]').map(b => b.attributes('data-testid'))

beforeEach(() => {
  vi.clearAllMocks()
  forms.fetchProductInfo.mockResolvedValue({ deviceName: '一歩庵点呼 v1', certPre: null, certPost: null })
})

describe('TenkoFilingManager', () => {
  it('保存した値を出し、種別ごとに様式を並べる', async () => {
    const w = await mountIt()
    expect((w.find('[data-testid="tenko-filing-business-number"]').element as HTMLInputElement).value).toBe('000000000001')
    expect(w.find('[data-testid="tenko-filing-business-number-hint"]').text()).toContain('分からなければ空欄のまま出せます')
    expect(dlButtons(w)).toEqual(['tenko-filing-dl-egov-tenko-todokede-sankou', 'tenko-filing-dl-remote-kamotsu-bessi7-jisshi'])
    await w.find('[data-testid="tenko-filing-kind-auto"]').setValue(true)
    expect(dlButtons(w)).toEqual(['tenko-filing-dl-egov-tenko-todokede-sankou'])
    expect(w.text()).toContain('認定番号が要ります')
    expect(w.find('[data-testid="tenko-filing-kind-note"]').text()).toContain('原則 10 日前まで')
  })

  it('実施予定日は申請日の 10 日後より前を選べず、申請日を後ろへずらして割ったら空に戻す', async () => {
    const w = await mountIt()
    const apply = w.find('[data-testid="tenko-filing-download"] input[type="date"]')
    const start = () => w.find('[data-testid="tenko-filing-start-date"]')
    await apply.setValue('2026-11-04')
    expect(start().attributes('min')).toBe('2026-11-14')
    await start().setValue('2026-11-20')
    await apply.setValue('2026-11-08')
    expect([start().attributes('min'), (start().element as HTMLInputElement).value]).toEqual(['2026-11-18', '2026-11-20'])
    await apply.setValue('2026-11-15')
    expect((start().element as HTMLInputElement).value).toBe('')
    await apply.setValue('')
    expect(start().attributes('min')).toBeUndefined()
  })

  it('「書き込む値」の下にダウンロードを置く (入れる → 保存 → 出す の順)', async () => {
    const w = await mountIt()
    const ids = w.findAll('[data-testid="tenko-filing-settings"], [data-testid="tenko-filing-download"]').map(e => e.attributes('data-testid'))
    expect(ids).toEqual(['tenko-filing-settings', 'tenko-filing-download'])
  })

  it('機器の名称と認定番号の既定は製品の設定。保存済みの別の名称 (前の版) は残す', async () => {
    const sel = (w: W) => w.find('[data-testid="tenko-filing-device-name"]')
    const opts = (w: W) => sel(w).findAll('option').map(o => o.text())
    forms.fetchProductInfo.mockResolvedValue({ deviceName: '一歩庵点呼 v2', certPre: '前-1', certPost: '後-2' })
    const def = await mountIt(saved({ device_name: null }))
    expect([(sel(def).element as HTMLSelectElement).value, opts(def)]).toEqual(['一歩庵点呼 v2', ['一歩庵点呼 v2']])
    expect(def.findAll('[data-testid="tenko-filing-settings"] input').map(i => (i.element as HTMLInputElement).value)).toContain('前-1')
    const old = await mountIt(saved({ device_name: '一歩庵点呼 v1', auto_cert_pre: '前-0' }))
    expect([(sel(old).element as HTMLSelectElement).value, opts(old)]).toEqual(['一歩庵点呼 v1', ['一歩庵点呼 v2', '一歩庵点呼 v1']])
    expect(old.findAll('[data-testid="tenko-filing-settings"] input').map(i => (i.element as HTMLInputElement).value)).toContain('前-0')
  })

  it('読めないときは文言を出す (理由の記号は文にする)', async () => {
    const w = await mountIt(new Error('403 {"error":"forbidden"}'))
    expect(w.find('[data-testid="tenko-filing-load-error"]').text()).toBe('システム管理者だけが変更できます')
    const other = await mountIt(new Error(''))
    expect(other.find('[data-testid="tenko-filing-load-error"]').text()).toBe('設定を取得できませんでした')
  })

  it('営業所を足して消し、保存する', async () => {
    const w = await mountIt(saved({ offices: [] }))
    await w.find('[data-testid="tenko-filing-add-office"]').trigger('click')
    await w.find('[data-testid="tenko-filing-add-office"]').trigger('click')
    const rows = () => w.findAll('[data-testid="tenko-filing-office-role"]')
    expect(rows().map(s => (s.element as HTMLSelectElement).value)).toEqual(['1', '2'])
    await w.findAll('button').find(b => b.text() === '削除')!.trigger('click')
    api.putTenkoFilingSettings.mockResolvedValue(saved({ offices: [{ name: '', address: '', role: 2 }] }))
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(api.putTenkoFilingSettings.mock.calls[0]![0].offices).toEqual([{ name: '', address: '', role: 2 }])
    expect(w.find('[data-testid="tenko-filing-notice"]').text()).toBe('保存しました')
  })

  it('保存が外れたら理由を出す', async () => {
    const w = await mountIt()
    api.putTenkoFilingSettings.mockRejectedValueOnce(new Error('400 {"error":"invalid_business_number"}'))
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-save-error"]').text()).toBe('事業者番号は半角数字 12 桁で入力してください')
    api.putTenkoFilingSettings.mockRejectedValueOnce('x')
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-save-error"]').text()).toBe('保存できませんでした')
  })

  it('記入済みをダウンロードする (入力中の値と日付で)', async () => {
    const offices = Array.from({ length: 6 }, (_, i) => ({ name: `架空 ${i}`, address: null, role: 2 }))
    const w = await mountIt(saved({ offices }))
    expect(w.text()).toContain('5 件までです')
    forms.buildFilledForm.mockResolvedValue({ bytes: new Uint8Array([1]), filename: 'a.xlsx' })
    await w.find('[data-testid="tenko-filing-start-date"]').setValue('2026-11-20')
    await w.find('[data-testid="tenko-filing-dl-egov-tenko-todokede-sankou"]').trigger('click')
    await flushPromises()
    const [form, s, req] = forms.buildFilledForm.mock.calls[0]!
    expect([form.id, s.business_number, req.kind, req.startDate]).toEqual(['egov-tenko-todokede-sankou', '000000000001', 'remote', '2026-11-20'])
    expect(req.applyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(forms.saveBytes).toHaveBeenCalledWith(new Uint8Array([1]), 'a.xlsx', 'xlsx')

    forms.buildFilledForm.mockRejectedValueOnce(new Error('様式の版が想定と違います'))
    await w.find('[data-testid="tenko-filing-dl-remote-kamotsu-bessi7-jisshi"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-download-error"]').text()).toBe('様式の版が想定と違います')
    forms.buildFilledForm.mockRejectedValueOnce(null)
    await w.find('[data-testid="tenko-filing-dl-remote-kamotsu-bessi7-jisshi"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-download-error"]').text()).toBe('様式を作れませんでした')
  })
  it('e-Gov の申請データを選ぶと、保存した値と規則に照らした結果を出す (読めないファイルは理由)', async () => {
    const xml = (device: string, start = '2099/1/1', name = '甲') => `<DataRoot><届出報告情報><届出報告種別>実施</届出報告種別><届出報告内容><点呼の種別>遠隔点呼</点呼の種別><西暦>${start}</西暦>`
      + `<点呼に係る営業所又は車庫情報><申請1件目><点呼の実施被実施の別>実施</点呼の実施被実施の別><営業所又は車庫の名称>${name}</営業所又は車庫の名称><営業所又は車庫の位置>長崎県架空市1</営業所又は車庫の位置><使用する機器の名称>${device}</使用する機器の名称></申請1件目></点呼に係る営業所又は車庫情報>`
      + '<遠隔点呼又は事業者間遠隔点呼の場合><点呼機器システムのパンフレット等性能及び機能が確認できる書類>1</点呼機器システムのパンフレット等性能及び機能が確認できる書類><対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します>1</対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します></遠隔点呼又は事業者間遠隔点呼の場合>'
      + '</届出報告内容></届出報告情報></DataRoot>'
    const zipFile = (name: string, files: Record<string, string>) =>
      new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))], name)
    const kousei = '<DataRoot><提出先名称>国土交通省,九州運輸局,長崎運輸支局</提出先名称><添付書類ファイル名称>67_a.pdf</添付書類ファイル名称></DataRoot>'
    const w = await mountIt(saved({ device_name: null, offices: [{ name: '甲', address: '長崎県架空市1', role: 1 }] }))
    const input = w.find('[data-testid="tenko-filing-egov-input"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [
        zipFile('ok.zip', { 'x/15596A069500020000_01.xml': xml('一歩庵点呼 v1'), 'x/kousei.xml': kousei }),
        zipFile('ng.zip', { '15596A069500020000_01.xml': xml('一歩庵点呼　v01') }),
        zipFile('other.zip', { 'a.txt': 'x' }),
        zipFile('warn.zip', { '15596A069500020000_01.xml': xml('一歩庵点呼 v1', '', '乙') }),
      ],
    })
    await input.trigger('change')
    await flushPromises()
    const results = w.findAll('[data-testid="tenko-filing-egov-result"]').map(r => r.text().replace(/\s+/g, ' '))
    expect(results[0]).toBe('ok.zip実施 / 遠隔点呼 / 開始日 2099-01-01 / 提出先 長崎運輸支局食い違いは見つかりませんでした')
    expect(results[1]).toContain('提出先 -')
    expect(results[1]).toContain('要修正: 申請 1 件目 (甲): 使用する機器の名称が「一歩庵点呼 v01」です')
    expect(results[1]).toContain('要修正: #67 点呼機器のパンフレットのファイル')
    expect(results[2]).toBe('other.zipe-Gov の点呼の届出の申請データが見つかりません')
    expect(results[3]).toContain('開始日 -')
    expect(results[3]).toContain('確認: 申請 1 件目 (乙): 届出の画面に保存した営業所にありません')
    expect((input.element as HTMLInputElement).value).toBe('')

    Object.defineProperty(input.element, 'files', { configurable: true, value: [{ name: 'broken.zip', arrayBuffer: () => Promise.reject(null) }] })
    await input.trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-egov-result"]').text()).toContain('読めませんでした')
  })
})
