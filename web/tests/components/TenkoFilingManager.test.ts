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
  listFilingArchives: vi.fn(),
  saveFilingArchive: vi.fn(),
  downloadFilingArchive: vi.fn(),
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
  api.listFilingArchives.mockResolvedValue([])
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
    api.putTenkoFilingSettings.mockImplementation(async (s: FilingSettings) => s)
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(api.putTenkoFilingSettings.mock.calls[0]![0].partners).toEqual([
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
    const archive = { id: '20991231235959001e', name: '20991231235959001e.zip', size: 4, saved_at: '2099-12-31T00:00:00Z', saved_by: null, meta: { reportKind: '実施', tenkoType: '遠隔点呼', startDate: '2099-12-01', offices: ['甲', '乙'] } }
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
    const rows = w.findAll('[data-testid="tenko-filing-archive-row"]').map(r => r.findAll('td').map(td => td.text()))
    expect(rows).toEqual([
      ['20991231235959001e', '実施 / 遠隔点呼 / 開始 2099-12-01 / 甲・乙', '2099-12-31', 'ダウンロード'],
      ['2099123123595902', '架空の受委託', '2099-12-31', 'ダウンロード'],
      ['2099123123595903', '', '2099-12-31', 'ダウンロード'],
    ])
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

  it('控えの一覧を取れなければ理由を出す', async () => {
    api.listFilingArchives.mockRejectedValueOnce(new Error('403 {"error":"forbidden"}'))
    const w = await mountIt()
    expect(w.find('[data-testid="tenko-filing-archives-error"]').text()).toBe('システム管理者だけが変更できます')
  })
})
