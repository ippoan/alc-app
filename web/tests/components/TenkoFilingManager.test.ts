// 管理者の画面のタブ「点呼の届出」。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { strToU8, zipSync } from 'fflate'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoFilingManager from '~/components/TenkoFilingManager.vue'
import { emptySettings, type FilingSettings } from '~/utils/tenko-forms'

const api = vi.hoisted(() => ({
  getTenkoFilingSettings: vi.fn(),
  putTenkoFilingSettings: vi.fn(),
  listFilingArchives: vi.fn(),
  saveFilingArchive: vi.fn(),
  downloadFilingArchive: vi.fn(),
  fetchFilingArchive: vi.fn(),
  getEgovApplyStatus: vi.fn(),
  logoutEgov: vi.fn(),
  listTenkoCompanies: vi.fn(),
  setFilingArchiveCompanies: vi.fn(),
  getTenkoOffices: vi.fn(),
  listTenkoConsignments: vi.fn(),
}))
const rc = vi.hoisted(() => ({ egovLogin: '' }))
mockNuxtImport('useRuntimeConfig', original => () => {
  const c = original()
  return { ...c, public: { ...c.public, egovLogin: rc.egovLogin } }
})
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

const CO_A = { id: 'cccccccc-0001-0001-0001-cccccccccccc', name: '架空運輸', is_self: false, office_ids: [] as string[] }
const CO_B = { id: 'cccccccc-0002-0002-0002-cccccccccccc', name: '架空物流', is_self: true, office_ids: [] as string[] }

function saved(over: Partial<FilingSettings> = {}): FilingSettings {
  return { ...emptySettings(), business_number: '000000000001', updated_at: '2026-11-02T00:00:00Z', ...over }
}

async function mountIt(s: FilingSettings | Error | null = saved()) {
  if (s === null) { /* getTenkoFilingSettings はテスト側で決める */ }
  else if (s instanceof Error) api.getTenkoFilingSettings.mockRejectedValue(s)
  else api.getTenkoFilingSettings.mockResolvedValue(s)
  const w = await mountSuspended(TenkoFilingManager)
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const dlButtons = (w: W) => w.findAll('[data-testid^="tenko-filing-dl-"]').map(b => b.attributes('data-testid'))

beforeEach(() => {
  vi.clearAllMocks()
  rc.egovLogin = ''
  window.history.replaceState(null, '', '/?role=admin&tab=tenko_filing')
  api.listFilingArchives.mockResolvedValue([])
  api.listTenkoCompanies.mockResolvedValue([CO_A, CO_B])
  api.getTenkoOffices.mockResolvedValue({ offices: [], vehicles: [], carins_bases: [] })
  api.listTenkoConsignments.mockResolvedValue([])
  api.setFilingArchiveCompanies.mockResolvedValue({ id: '', company_ids: [] })
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

  it('機器の名称をコピーでき、2 秒で表示が戻る (e-Gov の欄へ貼るため)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    try {
      const w = await mountIt(saved({ device_name: null }))
      const btn = w.find('[data-testid="tenko-filing-device-name-copy"]')
      expect(btn.text()).toBe('コピー')
      await btn.trigger('click')
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('一歩庵点呼 v1')
      expect(btn.text()).toBe('コピーしました')
      vi.advanceTimersByTime(2000)
      await flushPromises()
      expect(btn.text()).toBe('コピー')
      w.vm.$.setupState.settings.device_name = null
      await btn.trigger('click')
      await flushPromises()
      expect(writeText).toHaveBeenLastCalledWith('')
    }
    finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
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
    expect(api.putTenkoFilingSettings.mock.calls[0]![1].offices).toEqual([{ name: '', address: '', role: 2 }])
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
    expect(results[0]).toBe('ok.zip実施 / 遠隔点呼 / 開始日 2099-01-01 / 提出先 長崎運輸支局食い違いは見つかりませんでした 空の欄にこの申請データの値を入れる')
    expect(results[1]).toContain('提出先 -')
    expect(results[1]).toContain('要修正: 申請 1 件目 (甲): 使用する機器の名称が「一歩庵点呼 v01」です')
    expect(results[1]).toContain('要修正: #67 点呼機器のパンフレットのファイル')
    expect(results[2]).toBe('other.zipe-Gov の申請データが見つかりません')
    expect(results[3]).toContain('開始日 -')
    expect(results[3]).toContain('確認: 申請 1 件目 (乙): 届出の画面に保存した営業所にありません')
    expect((input.element as HTMLInputElement).value).toBe('')

    Object.defineProperty(input.element, 'files', { configurable: true, value: [{ name: 'broken.zip', arrayBuffer: () => Promise.reject(null) }] })
    await input.trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-egov-result"]').text()).toContain('読めませんでした')
  })

  it('受委託の相手の会社と営業所を足して消し、保存で送る。外れた理由を文にする', async () => {
    const w = await mountIt(saved())
    await w.find('[data-testid="tenko-filing-add-partner"]').trigger('click')
    await w.find('[data-testid="tenko-filing-add-partner"]').trigger('click')
    expect(w.findAll('[data-testid="tenko-filing-partner"]').length).toBe(2)
    await w.findAll('[data-testid="tenko-filing-remove-partner"]')[1]!.trigger('click')
    const partner = w.find('[data-testid="tenko-filing-partner"]')
    await partner.findAll('input')[0]!.setValue('架空物流')
    await partner.find('[data-testid="tenko-filing-add-partner-office"]').trigger('click')
    await partner.find('[data-testid="tenko-filing-add-partner-office"]').trigger('click')
    await partner.findAll('[data-testid="tenko-filing-remove-partner-office"]')[0]!.trigger('click')
    await partner.findAll('input')[3]!.setValue('本社営業所')
    api.putTenkoFilingSettings.mockImplementation(async (_id: string, s: FilingSettings) => s)
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(api.putTenkoFilingSettings.mock.calls[0]![1].partners).toEqual([
      { name: '架空物流', address: null, representative: null, offices: [{ name: '本社営業所', address: null }] },
    ])
    for (const [word, text] of [
      ['invalid_postal_code', '郵便番号は半角数字 7 桁で入力してください'],
      ['invalid_corporate_number', '法人番号は半角数字 13 桁で入力してください'],
      ['too_many_partners', '受委託の相手の会社は 10 社までです'],
      ['invalid_partner', '受委託の相手の会社と、その営業所の名称を入力してください'],
    ]) {
      api.putTenkoFilingSettings.mockRejectedValueOnce(new Error(`400 {"error":"${word}"}`))
      await w.find('[data-testid="tenko-filing-save"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="tenko-filing-save-error"]').text()).toBe(text)
    }
  })

  const entrustZip = (name: string) => {
    const kousei = '<DataRoot><手続ID>15596A0478000001</手続ID><手続名称>架空の受委託</手続名称><申請者情報><氏名>架空 太郎</氏名><法人団体名>架空運輸</法人団体名></申請者情報>'
      + '<提出先名称>国土交通省,九州運輸局,長崎運輸支局</提出先名称></DataRoot>'
    const info = '<DataRoot><申請内容><委託者><氏名又は名称>架空物流</氏名又は名称><委託営業所><名称>本社</名称></委託営業所></委託者>'
      + '<受託者><氏名又は名称>架空運輸</氏名又は名称><受託営業所><名称>甲</名称></受託営業所></受託者>'
      + '<開始の予定日及び期間><西暦>2099/6/1</西暦><西暦>2104/5/31</西暦></開始の予定日及び期間>'
      + '<管理の委託受託契約書>1</管理の委託受託契約書><管理の報酬その他管理の実施方法の細目を記載した書類>1</管理の報酬その他管理の実施方法の細目を記載した書類></申請内容></DataRoot>'
    return new File([zipSync({ 'd/kousei.xml': strToU8(kousei), 'd/15596A047800020000_01.xml': strToU8(info) })], name)
  }
  const pick = async (w: W, files: File[]) => {
    const input = w.find('[data-testid="tenko-filing-egov-input"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: files })
    await input.trigger('change')
    await flushPromises()
  }

  it('受委託の一時保存を読み、空の欄に値を入れて照らし直す。ほかの手続は手続名を出す', async () => {
    const w = await mountIt(saved({ offices: [{ name: '甲', address: null, role: 1 }] }))
    const other = new File([zipSync({ 'k/kousei.xml': strToU8('<DataRoot><手続ID>999</手続ID></DataRoot>') })], 'other.zip')
    const bare = new File([zipSync({ 'k/kousei.xml': strToU8('<DataRoot/>') })], 'bare.zip')
    await pick(w, [entrustZip('input.zip'), other, bare])
    const text = () => w.findAll('[data-testid="tenko-filing-egov-result"]').map(r => r.text().replace(/\s+/g, ' '))
    expect(w.find('[data-testid="tenko-filing-egov-entrust"]').text().replace(/\s+/g, ' '))
      .toBe('受委託の許可申請 / 委託者 架空物流 → 受託者 架空運輸 / 期間 2099-06-01 〜 2104-05-31 / 提出先 長崎運輸支局')
    expect(text()[0]).toContain('確認: 委託者 (架空物流): 受委託の相手の会社に保存されていません')
    expect(text()[0]).not.toContain('控えとして保存')
    expect(text()[1]).toContain('999')
    expect(text()[2]).toContain('手続名なし')
    await w.find('[data-testid="tenko-filing-egov-adopt"]').trigger('click')
    await flushPromises()
    const s = w.vm.$.setupState.settings as FilingSettings
    expect([s.operator_name, s.operator_representative, s.partners.map(p => p.name)]).toEqual(['架空運輸', '架空 太郎', ['架空物流']])
    expect(w.find('[data-testid="tenko-filing-notice"]').text()).toContain('「保存」を押すと残ります')
    expect(text()[0]).not.toContain('受委託の相手の会社に保存されていません')
  })

  it('到達番号の名前の zip は控えとして保存でき、一覧からダウンロードする。失敗は理由を出す', async () => {
    const archive = { id: '20991231235959001e', name: '20991231235959001e.zip', size: 4, saved_at: '2099-12-31T00:00:00Z', saved_by: null, company_ids: [CO_B.id], meta: { reportKind: '実施', tenkoType: '遠隔点呼', startDate: '2099-12-01', offices: ['甲', '乙'] } }
    api.listFilingArchives.mockResolvedValueOnce([]).mockResolvedValueOnce([archive, { ...archive, id: '2099123123595902', meta: { procName: '架空の受委託' } }, { ...archive, id: '2099123123595903', meta: null }])
    const w = await mountIt(saved())
    expect(w.find('[data-testid="tenko-filing-archives"]').text()).toContain('まだありません')
    await pick(w, [entrustZip('20991231235959001e.zip')])
    api.saveFilingArchive.mockResolvedValueOnce(archive)
    await w.find('[data-testid="tenko-filing-egov-archive"]').trigger('click')
    await flushPromises()
    const [id, bytes, name, meta] = api.saveFilingArchive.mock.calls[0]!
    expect([id, bytes instanceof Uint8Array, name, meta]).toEqual(['20991231235959001e', true, '20991231235959001e.zip', {
      procedure: 'entrust', procName: '架空の受委託', reportKind: '', tenkoType: '', startDate: '2099-06-01', offices: [], destinations: ['長崎運輸支局'],
    }])
    expect(w.find('[data-testid="tenko-filing-egov-archive-result"]').text()).toBe('控えを保存しました')
    expect(api.setFilingArchiveCompanies).toHaveBeenCalledWith('20991231235959001e', [CO_B.id])
    const rows = w.findAll('[data-testid="tenko-filing-archive-row"]').map(r => r.findAll('td').map(td => td.text().replace(/\s+/g, ' ')))
    expect(rows).toEqual([
      ['20991231235959001e 架空物流実施 / 遠隔点呼 / 開始 2099-12-01 / 甲・乙', '2099-12-31', ''],
      ['2099123123595902 架空物流架空の受委託', '2099-12-31', ''],
      ['2099123123595903 架空物流', '2099-12-31', ''],
    ])
    expect(w.find('[data-testid="tenko-filing-archive-summary"]').exists()).toBe(true)
    api.saveFilingArchive.mockRejectedValueOnce(new Error('控えの保存に失敗しました (503): x'))
    await w.find('[data-testid="tenko-filing-egov-archive"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-egov-archive-result"]').text()).toBe('控えの保存に失敗しました (503): x')

    await w.find('[data-testid="tenko-filing-archive-download"]').trigger('click')
    await flushPromises()
    expect(api.downloadFilingArchive).toHaveBeenCalledWith('20991231235959001e', '20991231235959001e.zip')
    api.downloadFilingArchive.mockRejectedValueOnce(null)
    await w.find('[data-testid="tenko-filing-archive-download"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-archive-error"]').text()).toBe('控えをダウンロードできませんでした')
  })

  describe('申請済みの控えの e-Gov の状況と中身 (?arrive=)', () => {
    const A = '20991231235959001e'
    const B = '2099123123595902'
    const row = (id: string) => ({ id, name: `${id}.zip`, size: 4, saved_at: '2099-12-31T00:00:00Z', saved_by: null, company_ids: [CO_B.id], meta: null })
    const filingZip = (extra: Record<string, string> = {}) => zipSync({
      'x/kousei.xml': strToU8('<DataRoot><手続ID>15596A0695000001</手続ID><手続名称>架空の届出</手続名称><提出先名称>国土交通省,九州運輸局,長崎運輸支局</提出先名称></DataRoot>'),
      'x/15596A069500020000_01.xml': strToU8('<DataRoot><届出報告情報><届出報告種別>実施</届出報告種別><届出報告内容><点呼の種別>遠隔点呼</点呼の種別><西暦>2099/1/1</西暦></届出報告内容></届出報告情報></DataRoot>'),
      'x/': new Uint8Array(),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
    })
    const urls = vi.hoisted(() => ({ made: [] as string[], revoked: [] as string[] }))
    /** e-Gov の申請案件取得の要約 (server/api/egov/apply の応答)。値は架空 */
    const egov = (status: string, over: Record<string, unknown> = {}) => ({
      status, arrive_date: '2099-12-31 12:03:00', proc_name: '架空の届出', submission_destination: '架空運輸支局',
      corporation_name: '', applicant_name: '', applied_account: '', pay_status: '',
      notice_count: 0, doc_count: 0, notices: [], documents: [], ...over,
    })

    beforeEach(() => {
      urls.made = []
      urls.revoked = []
      URL.createObjectURL = vi.fn(() => {
        urls.made.push(`blob:${urls.made.length}`)
        return urls.made.at(-1)!
      })
      URL.revokeObjectURL = vi.fn((u: string) => { urls.revoked.push(u) })
    })

    it('e-Gov の状況は既定では出さない (戻り先の登録が済むまで)。egov-check へのリンクは出す', async () => {
      api.listFilingArchives.mockResolvedValue([row(A)])
      const w = await mountIt()
      expect(w.find('[data-testid="tenko-filing-egov-login"]').exists()).toBe(false)
      expect(w.find('[data-testid="tenko-filing-archive-egov"]').exists()).toBe(false)
      expect(api.getEgovApplyStatus).not.toHaveBeenCalled()
      expect(w.find('[data-testid="tenko-filing-archive-egov-check"]').attributes('href')).toBe(`https://egov-check.ippoan.org/apply/${A}`)
    })

    it('ログイン済みなら行ごとに状況のバッジと件数を出し (取れない行は理由を title に)、ログアウトでログインの入口に戻る', async () => {
      rc.egovLogin = 'on'
      const st = (status: string, notice = 0, doc = 0) => egov(status, { notice_count: notice, doc_count: doc })
      const ids = [A, B, '2099123123595903', '2099123123595904', '2099123123595905', '2099123123595906', '2099123123595907']
      api.listFilingArchives.mockResolvedValue(ids.map(row))
      api.getEgovApplyStatus.mockImplementation(async (id: string) => {
        if (id === A) return st('審査中', 1, 0)
        if (id === B) throw new Error('e-Gov のエラー (404): 該当なし')
        if (id === ids[2]) throw null
        return st({ [ids[3]!]: '到達', [ids[4]!]: '手続終了', [ids[5]!]: '取下げ済', [ids[6]!]: '架空の状態' }[id]!)
      })
      const w = await mountIt()
      const badges = w.findAll('[data-testid="tenko-filing-archive-egov"]')
      expect(badges.map(c => c.text())).toEqual(['審査中', '取得できません', '取得できません', '到達', '手続終了', '取下げ済', '架空の状態'])
      expect(badges.map(c => c.classes().find(k => /^text-[a-z]+-\d+$/.test(k)))).toEqual([
        'text-amber-800', 'text-red-700', 'text-red-700', 'text-blue-700', 'text-emerald-700', 'text-gray-600', 'text-gray-500',
      ])
      expect([badges[1]!.attributes('title'), badges[2]!.attributes('title'), badges[0]!.attributes('title')])
        .toEqual(['e-Gov のエラー (404): 該当なし', 'e-Gov の状況を取得できませんでした', undefined])
      const counts = w.findAll('[data-testid="tenko-filing-archive-row"]')[0]!.findAll('[data-testid="tenko-filing-archive-count"]')
      expect(counts.map(c => [c.text(), c.classes().includes('text-amber-700')])).toEqual([['通知 1', true], ['公文書 0', false]])
      expect(w.find('[data-testid="tenko-filing-egov-login-button"]').exists()).toBe(false)
      await w.find('[data-testid="tenko-filing-egov-logout"]').trigger('click')
      await flushPromises()
      expect(api.logoutEgov).toHaveBeenCalled()
      expect(w.find('[data-testid="tenko-filing-egov-login-button"]').attributes('href'))
        .toBe(`/api/egov/login?return=${encodeURIComponent('/?role=admin&tab=tenko_filing')}`)
      expect(new Set(w.findAll('[data-testid="tenko-filing-archive-egov"]').map(c => c.text()))).toEqual(new Set(['未確認']))
    })

    it('開いた控えに e-Gov の段の帯を出す (いまの段まで色、日時は到達だけ)。取下げ・知らない状況は帯を出さず、取れなければ理由', async () => {
      rc.egovLogin = 'on'
      const ids = [A, B, '2099123123595903', '2099123123595904', '2099123123595905']
      api.listFilingArchives.mockResolvedValue(ids.map(row))
      const st = (status: string) => egov(status, { notice_count: 2 })
      api.getEgovApplyStatus.mockImplementation(async (id: string) => {
        if (id === ids[4]) throw new Error('e-Gov のエラー (404): 該当なし')
        return st({ [A]: '審査中', [B]: '手続終了', [ids[2]!]: '取下げ済', [ids[3]!]: '架空の状態' }[id]!)
      })
      api.fetchFilingArchive.mockResolvedValue(zipSync({ 'a.txt': strToU8('x') }))
      const w = await mountIt()
      const openRow = async (i: number) => {
        await w.findAll('[data-testid="tenko-filing-archive-row"]')[i]!.trigger('click')
        await flushPromises()
      }
      const states = () => w.findAll('[data-testid="tenko-filing-opened-egov-stages"] li').map(li => li.attributes('data-state'))
      await openRow(0)
      const box = () => w.find('[data-testid="tenko-filing-opened-egov"]')
      expect(box().text()).toContain('e-Gov のステータス: 審査中')
      expect(box().text()).toContain('通知 2')
      expect(states()).toEqual(['done', 'current', 'todo', 'todo'])
      expect(box().text()).toContain('2099-12-31 12:03')
      await openRow(1)
      expect(states()).toEqual(['done', 'done', 'done', 'current'])
      await openRow(2)
      expect(box().text()).toContain('取下げ済')
      expect(w.find('[data-testid="tenko-filing-opened-egov-stages"]').exists()).toBe(false)
      await openRow(3)
      expect(w.find('[data-testid="tenko-filing-opened-egov-stages"]').exists()).toBe(false)
      await openRow(4)
      expect(box().text()).toBe('e-Gov のエラー (404): 該当なし')
    })

    it('行の 2 段目に手続名・提出先・到達日時、開いた控えに取れる項目と通知・公文書を出す (空の項目は出さない)', async () => {
      rc.egovLogin = 'on'
      api.listFilingArchives.mockResolvedValue([row(A), row(B)])
      api.getEgovApplyStatus.mockImplementation(async (id: string) => id === A
        ? egov('審査中', {
            corporation_name: '架空運輸', applicant_name: '架空 太郎', applied_account: 'a@example.test', pay_status: '納付不要',
            notice_count: 2, doc_count: 2,
            notices: [
              { title: '補正のお知らせ', type: '補正', issue_date: '2099-12-31 13:00:00', issuer: '架空局', correct_expired_date: '2100-01-10' },
              { title: '', type: '', issue_date: '2099-12-31 14:00:00', issuer: '', correct_expired_date: '' },
            ],
            documents: [
              { title: '受理通知', issue_date: '2099-12-31 15:00:00', expired_date: '2100-03-31', downloaded_date: '' },
              { title: '', issue_date: '2099-12-31 16:00:00', expired_date: '', downloaded_date: '' },
              { title: '許可書', issue_date: '2099-12-31 17:00:00', expired_date: '2100-03-31', downloaded_date: '2100-01-01 00:00:00' },
            ],
          })
        : egov('到達', { proc_name: '', submission_destination: '' }))
      api.fetchFilingArchive.mockResolvedValue(zipSync({ 'a.txt': strToU8('x') }))
      const w = await mountIt()
      expect(w.findAll('[data-testid="tenko-filing-archive-egov-line"]').map(x => x.text()))
        .toEqual(['架空の届出 ・ 架空運輸支局 ・ 到達 2099-12-31 12:03', '到達 2099-12-31 12:03'])
      await w.findAll('[data-testid="tenko-filing-archive-row"]')[0]!.trigger('click')
      await flushPromises()
      const fields = w.find('[data-testid="tenko-filing-opened-egov-fields"]')
      expect(fields.findAll('dt').map(x => x.text())).toEqual(['手続名', '提出先', '到達日時', '法人名', '申請者', '提出したアカウント', '納付状況'])
      const notices = w.findAll('[data-testid="tenko-filing-opened-egov-notices"] > div').slice(1).map(x => x.findAll(':scope > span').map(t => t.text().replace(/\s+/g, ' ')).join(' '))
      expect(notices).toEqual(['補正 補正のお知らせ 2099-12-31 13:00 ・架空局 補正期限 2100-01-10', '件名なし 2099-12-31 14:00'])
      const docs = w.findAll('[data-testid="tenko-filing-opened-egov-documents"] > div').slice(1).map(x => x.findAll(':scope > span').map(t => t.text().replace(/\s+/g, ' ')).join(' '))
      expect(docs).toEqual(['受理通知 2099-12-31 15:00 未取得 (取得期限 2100-03-31)', '件名なし 2099-12-31 16:00 未取得', '許可書 2099-12-31 17:00 取得済み'])
      await w.findAll('[data-testid="tenko-filing-archive-row"]')[1]!.trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="tenko-filing-opened-egov-fields"]').findAll('dt').map(x => x.text())).toEqual(['到達日時'])
      expect(w.find('[data-testid="tenko-filing-opened-egov-notices"]').exists()).toBe(false)
      expect(w.find('[data-testid="tenko-filing-opened-egov-documents"]').exists()).toBe(false)
    })

    it('e-Gov に未ログインならログインの入口を出す。ログインに失敗して戻ったら知らせ、印は URL から消す', async () => {
      rc.egovLogin = 'on'
      window.history.replaceState(null, '', '/?role=admin&tab=tenko_filing&egov=ng')
      api.listFilingArchives.mockResolvedValue([row(A)])
      api.getEgovApplyStatus.mockResolvedValue(null)
      const w = await mountIt()
      expect(w.find('[data-testid="tenko-filing-egov-login-failed"]').exists()).toBe(true)
      expect(window.location.search).toBe('?role=admin&tab=tenko_filing')
      expect(w.find('[data-testid="tenko-filing-egov-login-button"]').exists()).toBe(true)
      expect(w.find('[data-testid="tenko-filing-egov-logout"]').exists()).toBe(false)
    })

    it('控えの一覧が取れなければ e-Gov には聞かない', async () => {
      rc.egovLogin = 'on'
      api.listFilingArchives.mockRejectedValue(new Error('x'))
      await mountIt()
      expect(api.getEgovApplyStatus).not.toHaveBeenCalled()
    })

    it('?arrive= で控えの中身 (要約・照らした結果・中のファイル) を開き、閉じると URL から消す', async () => {
      window.history.replaceState(null, '', `/?role=admin&tab=tenko_filing&arrive=${A}`)
      api.fetchFilingArchive.mockResolvedValue(filingZip({ 'x/67_a.pdf': '%PDF', 'x/b.bin': 'b' }))
      const w = await mountIt(saved({ offices: [] }))
      expect(api.fetchFilingArchive).toHaveBeenCalledWith(A)
      const o = w.find('[data-testid="tenko-filing-opened"]')
      expect(o.text()).toContain(A)
      expect(w.find('[data-testid="tenko-filing-opened-summary"]').text().replace(/\s+/g, ' ')).toBe('実施 / 遠隔点呼 / 申請日 - / 開始日 2099-01-01 / 提出先 長崎運輸支局')
      expect(w.find('[data-testid="tenko-filing-opened-findings"]').text()).toContain('要修正')
      expect(w.find('[data-testid="tenko-filing-opened-files"]').findAll('li').map(li => li.findAll('span, a').map(x => x.text()).filter(t => !t.includes('KB開く')).join(' ')))
        .toEqual(['kousei.xml 1 KB 開く 保存', '15596A069500020000_01.xml 1 KB 開く 保存', '67_a.pdf 1 KB 開く 保存', 'b.bin 1 KB 開く 保存'])
      const types = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls.map(([b]) => (b as Blob).type)
      expect(types).toEqual(['application/xml', 'application/xml', 'application/pdf', 'application/octet-stream'])
      expect(w.find('[data-testid="tenko-filing-opened-egov-check"]').attributes('href')).toBe(`https://egov-check.ippoan.org/apply/${A}`)
      await w.find('[data-testid="tenko-filing-opened-close"]').trigger('click')
      expect(w.find('[data-testid="tenko-filing-opened"]').exists()).toBe(false)
      expect(urls.revoked).toEqual(urls.made)
      expect(window.location.search).toBe('?role=admin&tab=tenko_filing')
    })

    it('行の「中身を見る」で開き、URL に到達番号を載せる。受委託・ほかの手続・読めない zip も出す', async () => {
      api.listFilingArchives.mockResolvedValue([row(A)])
      const w = await mountIt()
      const open = async (bytes: Uint8Array) => {
        api.fetchFilingArchive.mockResolvedValueOnce(bytes)
        await w.find('[data-testid="tenko-filing-archive-row"]').trigger('click')
        await flushPromises()
      }
      await open(zipSync({ 'k/kousei.xml': strToU8('<DataRoot/>'), 'k/15596A047800020000_01.xml': strToU8('<DataRoot><申請内容><委託者><氏名又は名称>架空物流</氏名又は名称></委託者><受託者/></申請内容></DataRoot>') }))
      expect(window.location.search).toBe(`?role=admin&tab=tenko_filing&arrive=${A}`)
      expect(w.find('[data-testid="tenko-filing-opened-summary"]').text().replace(/\s+/g, ' ')).toBe('受委託の許可申請 / 委託者 架空物流 → 受託者 - / 期間 - 〜 -')
      await open(zipSync({ 'k/kousei.xml': strToU8('<DataRoot><手続ID>999</手続ID></DataRoot>') }))
      expect(w.find('[data-testid="tenko-filing-opened-summary"]').text()).toBe('999')
      expect(w.text()).toContain('食い違いは見つかりませんでした')
      await open(zipSync({ 'k/kousei.xml': strToU8('<DataRoot/>') }))
      expect(w.find('[data-testid="tenko-filing-opened-summary"]').text()).toBe('手続名なし')
      await open(zipSync({ 'a.txt': strToU8('x') }))
      expect(w.find('[data-testid="tenko-filing-opened-error"]').text()).toBe('e-Gov の申請データが見つかりません')
      expect(w.find('[data-testid="tenko-filing-opened-files"]').text()).toContain('a.txt')
      // 開き直すたびに前のファイルの URL を返す (2 + 1 + 1)
      expect(urls.revoked.length).toBe(4)
    })

    it('到達番号の形でない・取れないときは理由を出す', async () => {
      window.history.replaceState(null, '', '/?role=admin&tab=tenko_filing&arrive=abc')
      const w = await mountIt()
      expect(api.fetchFilingArchive).not.toHaveBeenCalled()
      expect(w.find('[data-testid="tenko-filing-opened-error"]').text()).toBe('到達番号の形ではありません')
      api.listFilingArchives.mockResolvedValue([row(A)])
      api.fetchFilingArchive.mockRejectedValueOnce(null)
      window.history.replaceState(null, '', `/?role=admin&tab=tenko_filing&arrive=${A}`)
      const w2 = await mountIt()
      expect(w2.find('[data-testid="tenko-filing-opened-error"]').text()).toBe('控えを取得できませんでした')
    })

    it('未保存の到達番号は「控えは未保存」と出し、選んだ zip をその到達番号で保存して開き直す。失敗は理由', async () => {
      window.history.replaceState(null, '', `/?role=admin&tab=tenko_filing&arrive=${A}`)
      api.fetchFilingArchive.mockResolvedValueOnce(null)
      const w = await mountIt()
      expect(w.find('[data-testid="tenko-filing-opened-missing"]').text()).toContain('未保存')
      const choose = async (file: unknown) => {
        const input = w.find('[data-testid="tenko-filing-opened-save-input"]')
        Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
        await input.trigger('change')
        await flushPromises()
      }
      await choose(new File([zipSync({ 'a.txt': strToU8('x') })], 'x.zip'))
      expect(api.saveFilingArchive).not.toHaveBeenCalled()
      expect(w.find('[data-testid="tenko-filing-opened-save-error"]').text()).toBe('e-Gov の申請データが見つかりません')
      api.saveFilingArchive.mockRejectedValueOnce(null)
      await choose(new File([filingZip()], 'y.zip'))
      expect(w.find('[data-testid="tenko-filing-opened-save-error"]').text()).toBe('控えを保存できませんでした')
      api.saveFilingArchive.mockResolvedValueOnce(row(A))
      api.fetchFilingArchive.mockResolvedValueOnce(filingZip())
      api.listFilingArchives.mockResolvedValue([row(A)])
      await choose(new File([filingZip()], 'z.zip'))
      const [id, , name, meta] = api.saveFilingArchive.mock.calls.at(-1)!
      expect([id, name, (meta as { procName: string }).procName]).toEqual([A, 'z.zip', '架空の届出'])
      expect(w.find('[data-testid="tenko-filing-opened-missing"]').exists()).toBe(false)
      expect(w.find('[data-testid="tenko-filing-opened-summary"]').exists()).toBe(true)
      expect(w.findAll('[data-testid="tenko-filing-archive-row"]').length).toBe(1)
    })
  })

  it('控えの一覧を取れなければ理由を出す', async () => {
    api.listFilingArchives.mockRejectedValueOnce(new Error('403 {"error":"forbidden"}'))
    const w = await mountIt()
    expect(w.find('[data-testid="tenko-filing-archives-error"]').text()).toBe('システム管理者だけが変更できます')
  })

  describe('事業者ごとの切り替え', () => {
    const A = '20991231235959001e'
    const arc = (id: string, company_ids: string[]) => ({ id, name: `${id}.zip`, size: 4, saved_at: '2099-12-31T00:00:00Z', saved_by: null, company_ids, meta: null })
    const ids = (w: W) => w.findAll('[data-testid="tenko-filing-archive-row"]').map(r => r.find('.font-mono').text().split(' ')[0])
    const rows = (w: W) => w.findAll('[data-testid="tenko-company-row"]')

    it('既定の事業者の書き込む値を、company_id 付きで読む。行を選ぶと別の事業者の値に切り替わる', async () => {
      api.getTenkoFilingSettings.mockImplementation(async (id: string) => saved({ business_number: id === CO_A.id ? '000000000001' : '000000000002' }))
      const w = await mountIt(null)
      const num = () => (w.find('[data-testid="tenko-filing-business-number"]').element as HTMLInputElement).value
      expect(api.getTenkoFilingSettings).toHaveBeenCalledWith(CO_B.id)
      expect([num(), w.find('[data-testid="tenko-filing-company-name"]').text()]).toEqual(['000000000002', '架空物流'])
      await rows(w)[0]!.trigger('click')
      await flushPromises()
      expect(api.getTenkoFilingSettings).toHaveBeenLastCalledWith(CO_A.id)
      expect([num(), w.find('[data-testid="tenko-filing-company-name"]').text()]).toEqual(['000000000001', '架空運輸'])
      api.putTenkoFilingSettings.mockImplementation(async (_id: string, v: FilingSettings) => v)
      await w.find('[data-testid="tenko-filing-save"]').trigger('click')
      await flushPromises()
      expect(api.putTenkoFilingSettings.mock.calls[0]![0]).toBe(CO_A.id)
    })

    it('既定が無ければ先頭を選ぶ。事業者が無いときは「事業者を追加してください」だけ出し、値は読まない', async () => {
      api.listTenkoCompanies.mockResolvedValue([{ ...CO_A }])
      const first = await mountIt()
      expect(api.getTenkoFilingSettings).toHaveBeenCalledWith(CO_A.id)
      expect(first.find('[data-testid="tenko-filing-settings"]').exists()).toBe(true)
      api.getTenkoFilingSettings.mockClear()
      api.listTenkoCompanies.mockResolvedValue([])
      const none = await mountIt()
      expect(api.getTenkoFilingSettings).not.toHaveBeenCalled()
      expect(none.find('[data-testid="tenko-filing-settings"]').exists()).toBe(false)
      expect(none.find('[data-testid="tenko-filing-no-company"]').text()).toBe('事業者を追加してください')
    })

    it('事業者の一覧・値が取れなければ理由を出す。切り替えの途中で戻った古い応答は捨てる', async () => {
      api.listTenkoCompanies.mockRejectedValueOnce(new Error('403 {"error":"forbidden"}'))
      const bad = await mountIt()
      expect(bad.find('[data-testid="tenko-filing-load-error"]').text()).toBe('システム管理者だけが変更できます')
      let slow!: (v: FilingSettings) => void
      api.getTenkoFilingSettings.mockImplementationOnce(() => new Promise<FilingSettings>((r) => { slow = r }))
      const w = await mountIt(null)
      expect(api.getTenkoFilingSettings).toHaveBeenCalledTimes(1)
      api.getTenkoFilingSettings.mockResolvedValueOnce(saved({ business_number: '000000000001' }))
      await rows(w)[0]!.trigger('click')
      await flushPromises()
      slow(saved({ business_number: '999999999999' }))
      await flushPromises()
      expect((w.find('[data-testid="tenko-filing-business-number"]').element as HTMLInputElement).value).toBe('000000000001')
      api.getTenkoFilingSettings.mockRejectedValueOnce(new Error('404 not found'))
      await rows(w)[1]!.trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="tenko-filing-load-error"]').text()).toContain('not found')
    })

    it('控えは選んだ事業者のものと、どこにも付いていないもの (「振り分けていない控え」) を出す', async () => {
      api.listFilingArchives.mockResolvedValue([arc('1', [CO_A.id]), arc('2', [CO_B.id]), arc('3', []), arc('4', [CO_A.id, CO_B.id])])
      const w = await mountIt()
      expect(ids(w)).toEqual(['2', '4', '3'])
      expect(w.findAll('[data-testid="tenko-filing-archive-unassigned"]').map(e => e.text())).toEqual(['振り分けていない控え'])
      expect(w.findAll('[data-testid="tenko-filing-archive-companies"]').map(e => e.text())).toEqual(['架空物流', '架空運輸・架空物流'])
      await rows(w)[0]!.trigger('click')
      await flushPromises()
      expect(ids(w)).toEqual(['1', '4', '3'])
    })

    it('控えごとに事業者を付け替えられる (複数可)。失敗は理由を出す', async () => {
      api.listFilingArchives.mockResolvedValue([arc('3', [])])
      const w = await mountIt()
      const open = () => w.find('[data-testid="tenko-filing-archive-assign"]').trigger('click')
      await open()
      expect(w.findAll('[data-testid="tenko-filing-archive-assign-company"]')).toHaveLength(2)
      await open()
      expect(w.find('[data-testid="tenko-filing-archive-assign-row"]').exists()).toBe(false)
      await open()
      const boxes = w.findAll('[data-testid="tenko-filing-archive-assign-company"]')
      await boxes[0]!.setValue(true)
      await boxes[1]!.setValue(true)
      api.setFilingArchiveCompanies.mockRejectedValueOnce(new Error('400 {"error":"invalid_company"}'))
      await w.find('[data-testid="tenko-filing-archive-assign-save"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="tenko-filing-archive-assign-error"]').text()).toBe('事業者を選び直してください')
      api.listFilingArchives.mockResolvedValue([arc('3', [CO_A.id, CO_B.id])])
      await w.find('[data-testid="tenko-filing-archive-assign-save"]').trigger('click')
      await flushPromises()
      expect(api.setFilingArchiveCompanies).toHaveBeenLastCalledWith('3', [CO_A.id, CO_B.id])
      expect(w.find('[data-testid="tenko-filing-archive-assign-row"]').exists()).toBe(false)
      expect(w.find('[data-testid="tenko-filing-archive-companies"]').text()).toBe('架空運輸・架空物流')
    })

    it('保存した控えには選んでいる事業者を足す (すでに付いている事業者は残す)。事業者が無ければ付けない', async () => {
      window.history.replaceState(null, '', `/?role=admin&tab=tenko_filing&arrive=${A}`)
      api.listFilingArchives.mockResolvedValue([arc(A, [CO_A.id])])
      api.fetchFilingArchive.mockResolvedValue(null)
      const w = await mountIt()
      expect(w.find('[data-testid="tenko-filing-opened-missing"]').exists()).toBe(true)
      expect(api.setFilingArchiveCompanies).not.toHaveBeenCalled()
      const bytes = zipSync({ 'x/kousei.xml': strToU8('<DataRoot><手続ID>15596A0695000001</手続ID></DataRoot>') })
      const input = w.find('[data-testid="tenko-filing-opened-save-input"]')
      Object.defineProperty(input.element, 'files', { value: [new File([bytes as BlobPart], 'a.zip')], configurable: true })
      await input.trigger('change')
      await flushPromises()
      expect(api.saveFilingArchive).toHaveBeenCalled()
      expect(api.setFilingArchiveCompanies).toHaveBeenCalledWith(A, [CO_A.id])
    })

    it('事業者が付いている控えを ?arrive= で開くと、その事業者を選んだ状態にする', async () => {
      window.history.replaceState(null, '', `/?role=admin&tab=tenko_filing&arrive=${A}`)
      api.listFilingArchives.mockResolvedValue([arc(A, [CO_A.id])])
      api.fetchFilingArchive.mockResolvedValue(null)
      const w = await mountIt()
      expect(api.getTenkoFilingSettings).toHaveBeenLastCalledWith(CO_A.id)
      expect(w.find('[data-testid="tenko-filing-company-name"]').text()).toBe('架空運輸')
      expect(rows(w)[0]!.classes()).toContain('bg-blue-50')
    })
  })
})
