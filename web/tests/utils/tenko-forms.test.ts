// 点呼の届出・認定申請の様式への差し込み。様式は位置だけ本物に合わせた合成の xlsx / docx で、値は架空。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  BROCHURE_FILENAME, BROCHURE_URL, DocxBody, TENKO_FORMS, TENKO_FORMS_RAW, bessi7OfficeName, buildFilingZip, buildFilledForm, deviceLabel, deviceNameOptions, fetchProductInfo, earliestStartDate, egovCells, egovChecks,
  egovOfficeRow, emptySettings, fillBessi7, fillDocx, fillEgovXlsx, latestFormPath,
  reiwaDate, saveBytes, setXlsxCell, slashDate, xlsxCellText,
  type FilingRequest, type FilingSettings,
} from '~/utils/tenko-forms'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function settings(over: Partial<FilingSettings> = {}): FilingSettings {
  return {
    ...emptySettings(),
    business_number: '000000000001',
    trade_name: '架空屋号',
    business_type: 1,
    offices: [
      { name: '架空運輸 本社営業所', address: '架空県架空市1-1', role: 1 },
      { name: '架空運輸 第二車庫', address: null, role: 2 },
    ],
    auto_cert_pre: '前-0001',
    auto_cert_post: '後-0002',
    operator_name: '架空運輸株式会社',
    operator_address: '架空県架空市1-1',
    operator_representative: '架空 太郎',
    operator_contact_name: '架空 花子',
    operator_contact_phone: '000-0000-0000',
    operator_contact_email: 'contact@example.com',
    ...over,
  }
}
const REMOTE: FilingRequest = { kind: 'remote', applyDate: '2026-11-10', startDate: '2026-11-20' }
const AUTO: FilingRequest = { kind: 'auto', applyDate: '2026-11-10', startDate: '' }

describe('日付', () => {
  it('e-Gov は西暦・スラッシュ、国交省は令和', () => {
    expect(slashDate('2026-01-05')).toBe('2026/1/5')
    expect(slashDate('')).toBe('')
    expect(reiwaDate('2026-11-10')).toBe('令和8年11月10日')
    expect(reiwaDate('2019-05-01')).toBe('令和1年5月1日')
    expect(reiwaDate('2018-12-31')).toBe('令和　　年　　月　　日')
    expect(reiwaDate('x')).toBe('令和　　年　　月　　日')
  })
})

describe('実施予定日の下限と手続の別', () => {
  it('申請日の 10 日後 (月・年をまたぐ)。申請日が読めなければ下限なし', () => {
    expect(earliestStartDate('2026-11-04')).toBe('2026-11-14')
    expect(earliestStartDate('2026-12-25')).toBe('2027-01-04')
    expect(earliestStartDate('2028-02-20')).toBe('2028-03-01')
    expect(earliestStartDate('')).toBe('')
  })

})

describe('製品の設定 (機器の名称と認定番号)', () => {
  it('先頭が今の製品の名称。保存済みの別の名称 (前の版など) は消さずに末尾に残す', () => {
    expect(deviceNameOptions(null)).toEqual(['一歩庵点呼 v1'])
    expect(deviceNameOptions('一歩庵点呼 v2', '一歩庵点呼 v2')).toEqual(['一歩庵点呼 v2'])
    expect(deviceNameOptions('一歩庵点呼 v1', '一歩庵点呼 v2')).toEqual(['一歩庵点呼 v2', '一歩庵点呼 v1'])
  })

  it('tenko-forms の product/ippoan-tenko.json から名称と認定番号を読む。読めなければ既定の名称だけ', async () => {
    const f = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch
    const cfg = { product: '一歩庵点呼', version: 'v2', certification: { pre: '前-1', post: null } }
    const ok = f(new Response(JSON.stringify(cfg)))
    expect(await fetchProductInfo(ok)).toEqual({ deviceName: '一歩庵点呼 v2', certPre: '前-1', certPost: null })
    expect(vi.mocked(ok).mock.calls[0]![0]).toBe(`${TENKO_FORMS_RAW}product/ippoan-tenko.json`)
    expect(await fetchProductInfo(f(new Response(JSON.stringify({ product: 'x', version: 'v1' }))))).toEqual({ deviceName: 'x v1', certPre: null, certPost: null })
    const fallback = { deviceName: '一歩庵点呼 v1', certPre: null, certPost: null }
    expect(await fetchProductInfo(f(new Response('', { status: 404 })))).toEqual(fallback)
    expect(await fetchProductInfo(f(new Response('{"product":1}')))).toEqual(fallback)
    expect(await fetchProductInfo(vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)).toEqual(fallback)
  })
})

describe('deviceLabel', () => {
  it('遠隔点呼は名称だけ、自動点呼は認定番号も書く', () => {
    expect(deviceLabel(settings(), 'remote')).toBe('一歩庵点呼 v1')
    expect(deviceLabel(settings(), 'auto')).toBe(
      '一歩庵点呼 v1 (業務前自動点呼機器 認定番号 前-0001、業務後自動点呼機器 認定番号 後-0002)',
    )
    expect(deviceLabel(settings({ auto_cert_pre: null }), 'auto')).toBe('一歩庵点呼 v1 (業務後自動点呼機器 認定番号 後-0002)')
    expect(deviceLabel(settings({ auto_cert_pre: null, auto_cert_post: null, device_name: null }), 'auto')).toBe('')
  })
})

describe('egovCells', () => {
  it('遠隔点呼: #3〜#22 と #64・#65', () => {
    const c = egovCells(settings(), REMOTE)
    expect(c).toMatchObject({
      M8: '2026/11/10', M10: '000000000001', M11: '架空屋号', M15: '1実施', M17: '1一般貨物', M18: '4遠隔点呼',
      M19: '2026/11/20', M22: '1実施', M24: '架空運輸 本社営業所', M25: '架空県架空市1-1', M27: '一歩庵点呼 v1',
      M29: '2被実施', M31: '架空運輸 第二車庫', M32: '', M69: '1点呼を行う運行管理者等が属する自社営業所',
      M70: '1自社営業所又は自社営業所の車庫',
    })
    expect(egovChecks('remote')).toEqual(['M72', 'M74'])
  })

  it('自動点呼: #13 は 6、#64・#65 は書かない。営業所は 5 件まで', () => {
    const offices = Array.from({ length: 6 }, (_, i) => ({ name: `架空 ${i}`, address: null, role: 3 }))
    const c = egovCells(settings({ offices, business_type: null, business_number: null, trade_name: null }), AUTO)
    expect(c.M18).toBe('6自動点呼')
    expect(c.M17).toBe('')
    expect(c.M10).toBe('')
    expect(c.M11).toBe('')
    expect(c.M19).toBe('')
    expect(c.M69).toBeUndefined()
    expect(c[`M${egovOfficeRow(4)}`]).toBe('3実施・被実施両方')
    expect(c[`M${egovOfficeRow(5)}`]).toBeUndefined()
    expect(egovChecks('auto')).toEqual(['M79'])
  })
})

describe('xlsx のセル', () => {
  const sheet = '<sheetData>'
    + '<row r="8"><c r="E8" s="1" t="s"><v>0</v></c><c r="M8" s="28"/></row>'
    + '<row r="10"><c r="E10" s="1"><v>5</v></c><c r="N10" s="2" t="inlineStr"><is><t>任意</t></is></c></row>'
    + '<row r="11"><c r="E11" s="1"/></row>'
    + '<row r="12"/>'
    + '<row r="13" spans="1:2"></row>'
    + '</sheetData>'

  it('今の文を読む (共有文字列・数・inline・無い)', () => {
    expect(xlsxCellText(sheet, ['申請日'], 'E8')).toBe('申請日')
    expect(xlsxCellText(sheet, [], 'E8')).toBe('')
    expect(xlsxCellText(sheet, [], 'E10')).toBe('5')
    expect(xlsxCellText(sheet, [], 'N10')).toBe('任意')
    expect(xlsxCellText(sheet, [], 'M8')).toBe('')
    expect(xlsxCellText(sheet, [], 'Z99')).toBe('')
  })

  it('在るセルは書式を残して置き換え、無いセルは列の順に足す', () => {
    let s = setXlsxCell(sheet, 'M8', 'a&<b>"')
    expect(s).toContain('<c r="M8" s="28" t="inlineStr"><is><t xml:space="preserve">a&amp;&lt;b&gt;&quot;</t></is></c>')
    s = setXlsxCell(s, 'M10', '1')
    expect(s).toMatch(/<c r="E10"[\s\S]*<c r="M10" t="inlineStr">[\s\S]*<c r="N10"/)
    s = setXlsxCell(s, 'M11', '2')
    expect(s).toContain('<row r="11"><c r="E11" s="1"/><c r="M11" t="inlineStr">')
    s = setXlsxCell(s, 'M12', '3')
    expect(s).toContain('<row r="12"><c r="M12" t="inlineStr"><is><t xml:space="preserve">3</t></is></c></row>')
    s = setXlsxCell(s, 'M13', '4')
    expect(s).toContain('<row r="13" spans="1:2"><c r="M13"')
    expect(xlsxCellText(s, [], 'M13')).toBe('4')
    expect(() => setXlsxCell(s, 'M99', 'x')).toThrow('99 行目')
  })
})

function xlsx(e8 = '申請日<rPh sb="0" eb="3"><t>シンセイビ</t></rPh>', withShared = true): Uint8Array {
  const rows = [8, 10, 11, 15, 17, 18, 19, 22, 24, 25, 27, 29, 31, 32, 34, 69, 70]
    .map(r => `<row r="${r}"/>`).join('')
  const sheet = `<worksheet><sheetData><row r="5"/>${rows.replace('<row r="8"/>', '<row r="8"><c r="E8" t="s"><v>0</v></c></row>')}`
    + '<row r="72"><c r="M72" s="31" t="s"><v>1</v></c></row>'
    + '<row r="74"><c r="M74" s="29" t="s"><v>2</v></c></row>'
    + '<row r="79"><c r="M79" s="29" t="s"><v>2</v></c></row></sheetData></worksheet>'
  const shared = `<sst><si><r><t>${e8.split('<rPh')[0]}</t></r>${e8.includes('<rPh') ? `<rPh${e8.split('<rPh')[1]}` : ''}</si>`
    + '<si><t>□　添付しました</t></si><si><t xml:space="preserve">□　要件を遵守します。</t></si></sst>'
  return zipSync({
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    ...(withShared ? { 'xl/sharedStrings.xml': strToU8(shared) } : {}),
  })
}
const sheetOf = (b: Uint8Array) => strFromU8(unzipSync(b)['xl/worksheets/sheet1.xml']!)

describe('fillEgovXlsx', () => {
  it('遠隔点呼の値とチェック欄を書く', () => {
    const s = sheetOf(fillEgovXlsx(xlsx(), settings(), REMOTE))
    expect(xlsxCellText(s, [], 'M18')).toBe('4遠隔点呼')
    expect(xlsxCellText(s, [], 'M24')).toBe('架空運輸 本社営業所')
    expect(xlsxCellText(s, [], 'M72')).toBe('☑　添付しました')
    expect(xlsxCellText(s, [], 'M74')).toBe('☑　要件を遵守します。')
    // 空の値 (2 件目の所在地) は書かない
    expect(s).not.toContain('r="M32"')
  })

  it('自動点呼は #74 (M79) だけにチェック', () => {
    const s = sheetOf(fillEgovXlsx(xlsx(), settings(), AUTO))
    expect(xlsxCellText(s, [], 'M79')).toBe('☑　要件を遵守します。')
    expect(s).toContain('<c r="M74" s="29" t="s"><v>2</v></c>')
  })

  it('版が違う・シートが無いときは書かない', () => {
    expect(() => fillEgovXlsx(xlsx('別の項目'), settings(), REMOTE)).toThrow('版が想定と違います')
    expect(() => fillEgovXlsx(xlsx(undefined, false), settings(), REMOTE)).toThrow('版が想定と違います')
    expect(() => fillEgovXlsx(zipSync({ 'a.xml': strToU8('<a/>') }), settings(), REMOTE)).toThrow('シートが見つかりません')
  })
})

// ---------------------------------------------------------------- docx

type Cell = string[]
type Child = string | Cell[][]

/** 段落 (文字列。'' は run の無い段落) と表 (行 → 列 → 段落) を並べた document.xml */
function documentXml(children: Child[]): string {
  const p = (t: string) => (t
    ? `<w:p>${t.split('|').map(x => `<w:r><w:t>${x}</w:t></w:r>`).join('')}</w:p>`
    : '<w:p><w:pPr><w:rPr><w:sz w:val="21"/></w:rPr></w:pPr></w:p>')
  const body = children.map(c => (typeof c === 'string'
    ? p(c)
    : `<w:tbl>${c.map(row => `<w:tr>${row.map(cell => `<w:tc>${cell.map(p).join('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`))
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join('')}</w:body></w:document>`
}
const docx = (children: Child[]) => zipSync({ 'word/document.xml': strToU8(documentXml(children)) })
const bodyOf = (b: Uint8Array) => new DocxBody(strFromU8(unzipSync(b)['word/document.xml']!))
const texts = (b: DocxBody) => Array.from(b.body.children).map(e => (e.localName === 'p' ? DocxBody.text(e) : '<tbl>'))
const cell = (b: DocxBody, t: number, r: number, c: number, p = 0) => DocxBody.text(b.cellPara(b.table(t), r, c, p))

const BESSI7: Child[] = [
  '別紙７', '', '届出書', '令和|　　年　　月　　日', '', '○○運輸局', '',
  '　　|住所　　　', '　　|氏名又は名称　　', '代表者氏名　', '（連絡先）|担当者氏名　', '（連絡先）電話番号　', '（連絡先）|ﾒｰﾙｱﾄﾞﾚｽ　',
  '', '', '本文', '', '記', '１．種類', '　　一般貨物・特定|貨物|・特定第二種貨物利用運送|・貨物軽', '', '２．', '例', '',
  '３．営業所・車庫の名称等',
  [[['営業所・車庫の名称（…）'], ['所在地'], ['機器']], [[''], [''], ['']], [[''], [''], ['']]],
  '', '４．遠隔点呼開始予定日　　　令和|　　年　　月　　日', '', '５．宣誓', '  |□　|要件を遵守します。',
]

describe('fillBessi7', () => {
  it('事業者・事業の種類・営業所 (行を足す)・日付・宣誓を書く', () => {
    const offices = [...settings().offices, { name: '架空運輸 第三車庫', address: '架空県架空市3-3', role: 3 }]
    const b = bodyOf(fillDocx(docx(BESSI7), d => fillBessi7(d, settings({ offices }), REMOTE)))
    const t = texts(b)
    expect(t[3]).toBe('令和8年11月10日')
    expect(t[7]).toBe('　　住所　架空県架空市1-1')
    expect(t[8]).toBe('　　氏名又は名称　架空運輸株式会社')
    expect(t[12]).toBe('（連絡先）ﾒｰﾙｱﾄﾞﾚｽ　contact@example.com')
    expect(t[19]).toBe('　　○一般貨物・特定貨物・特定第二種貨物利用運送・貨物軽')
    expect(cell(b, 0, 1, 0)).toBe('架空運輸 本社営業所（遠隔点呼実施営業所等）')
    expect(cell(b, 0, 2, 1)).toBe('')
    expect(cell(b, 0, 3, 0)).toBe('架空運輸 第三車庫（遠隔点呼実施営業所等・被遠隔点呼実施営業所等）')
    expect(cell(b, 0, 3, 2)).toBe('一歩庵点呼 v1')
    // run の無い段落に足した run は、段落の既定の書式を写す
    const run = b.cellPara(b.table(0), 1, 0).lastElementChild!
    expect([run.localName, run.firstElementChild!.localName, run.firstElementChild!.firstElementChild!.getAttribute('w:val')])
      .toEqual(['r', 'rPr', '21'])
    expect(t[27]).toBe('４．遠隔点呼開始予定日　　　令和8年11月20日')
    expect(t[30]).toBe('  ☑　要件を遵守します。')
  })

  it('値が無い欄・事業の種類が別紙7 に無いもの・予定日なしは元のまま', () => {
    const s = settings({ operator_address: null, business_type: 5, offices: [], device_name: null })
    const b = bodyOf(fillDocx(docx(BESSI7), d => fillBessi7(d, s, { ...REMOTE, startDate: '' })))
    const t = texts(b)
    expect(t[7]).toBe('　　住所　　　')
    expect(t[19]).toBe('　　一般貨物・特定貨物・特定第二種貨物利用運送・貨物軽')
    expect(t[27]).toBe('４．遠隔点呼開始予定日　　　令和　　年　　月　　日')
  })

  it('位置の文字が合わなければ書かない', () => {
    const broken = [...BESSI7]
    broken[7] = '所在地'
    expect(() => fillDocx(docx(broken), d => fillBessi7(d, settings(), REMOTE))).toThrow('「住所」の位置が合いません')
  })

  it('営業所の名称の別は 1〜3 だけ', () => {
    expect(bessi7OfficeName({ name: 'a', address: null, role: 2 })).toBe('a（被遠隔点呼実施営業所等）')
    expect(bessi7OfficeName({ name: 'a', address: null, role: 9 })).toBe('a')
  })
})

describe('DocxBody の見つからない位置', () => {
  it('本文・要素・表・升目が無ければ例外', () => {
    expect(() => new DocxBody(`<w:document ${W}/>`)).toThrow('本文が見つかりません')
    const b = new DocxBody(documentXml(['a', [[['x']]]]))
    expect(() => b.child(9)).toThrow('9 番目の要素')
    expect(() => b.table(1)).toThrow('2 番目の表')
    expect(() => b.cellPara(b.table(0), 3, 0)).toThrow('4 行 1 列')
    expect(() => b.cellPara(b.table(0), 0, 5)).toThrow('1 行 6 列')
    expect(() => b.cellPara(b.table(0), 0, 0, 2)).toThrow('1 行 1 列')
    expect(() => fillDocx(zipSync({ 'a.xml': strToU8('<a/>') }), () => {})).toThrow('本文が見つかりません')
  })

  it('書式の無い空の段落にも run を足せる', () => {
    const b = new DocxBody(`<w:document ${W}><w:body><w:p/></w:body></w:document>`)
    b.setText(b.child(0), () => '新しい文')
    expect(b.xml()).toMatch(/<w:p><w:r><w:t xml:space="preserve">新しい文<\/w:t><\/w:r><\/w:p>/)
  })
})

// ---------------------------------------------------------------- 取得と保存

describe('buildFilledForm', () => {
  const egov = TENKO_FORMS.find(f => f.id === 'egov-tenko-todokede-sankou')!
  const manifest = { forms: { 'egov-tenko-todokede-sankou': { latest: 'forms/egov-tenko-todokede-sankou/2026-11-03.xlsx' } } }

  function fetcher(over: { manifest?: Response, file?: Response } = {}) {
    return vi.fn(async (url: string) => (url.endsWith('manifest.json')
      ? over.manifest ?? new Response(JSON.stringify(manifest))
      : over.file ?? new Response(xlsx() as BlobPart))) as unknown as typeof fetch
  }

  it('manifest の最新版を取り、書いた中身と版付きのファイル名を返す', async () => {
    const f = fetcher()
    const { bytes, filename } = await buildFilledForm(egov, settings(), REMOTE, f)
    expect(filename).toBe('egov-tenko-todokede-sankou_remote_2026-11-03_記入済み.xlsx')
    expect(xlsxCellText(sheetOf(bytes), [], 'M18')).toBe('4遠隔点呼')
    expect(vi.mocked(f).mock.calls.map(c => c[0])).toEqual([
      `${TENKO_FORMS_RAW}manifest.json`,
      `${TENKO_FORMS_RAW}forms/egov-tenko-todokede-sankou/2026-11-03.xlsx`,
    ])
  })

  it('一覧・様式が取れない、一覧に無いときは例外', async () => {
    await expect(latestFormPath('x', fetcher({ manifest: new Response('', { status: 503 }) }))).rejects.toThrow('一覧を取得できませんでした (503)')
    await expect(latestFormPath('x', fetcher())).rejects.toThrow('様式 x が一覧にありません')
    await expect(latestFormPath('x', fetcher({ manifest: new Response('{}') }))).rejects.toThrow('一覧にありません')
    await expect(buildFilledForm(egov, settings(), REMOTE, fetcher({ file: new Response('', { status: 404 }) })))
      .rejects.toThrow('様式を取得できませんでした (404)')
  })

  it('版の日付が読めないパスは latest と名付ける', async () => {
    const odd = { forms: { 'egov-tenko-todokede-sankou': { latest: 'forms/egov/current.xlsx' } } }
    const { filename } = await buildFilledForm(egov, settings(), AUTO, fetcher({ manifest: new Response(JSON.stringify(odd)) }))
    expect(filename).toBe('egov-tenko-todokede-sankou_auto_latest_記入済み.xlsx')
  })

  it('様式の一覧の差し込みはどれも動く (docx は合成の本文で)', () => {
    const byId = Object.fromEntries(TENKO_FORMS.map(f => [f.id, f]))
    expect(byId['remote-kamotsu-bessi7-jisshi']!.fill(docx(BESSI7), settings(), REMOTE)).toBeInstanceOf(Uint8Array)
    expect(TENKO_FORMS.map(f => f.id)).toEqual(['egov-tenko-todokede-sankou', 'remote-kamotsu-bessi7-jisshi'])
  })
})

describe('buildFilingZip', () => {
  const egov = TENKO_FORMS.find(f => f.id === 'egov-tenko-todokede-sankou')!
  const manifest = { forms: { 'egov-tenko-todokede-sankou': { latest: 'forms/egov-tenko-todokede-sankou/2026-11-03.xlsx' } } }
  const pdf = strToU8('%PDF-架空')

  function fetcher(brochure: Response = new Response(pdf as BlobPart)) {
    return vi.fn(async (url: string) => {
      if (url === BROCHURE_URL) return brochure
      return url.endsWith('manifest.json') ? new Response(JSON.stringify(manifest)) : new Response(xlsx() as BlobPart)
    }) as unknown as typeof fetch
  }

  it('遠隔点呼は記入済みの様式とパンフレット (67_) を 1 つの zip に入れる', async () => {
    const f = fetcher()
    const { bytes, filename } = await buildFilingZip([egov], settings(), REMOTE, f)
    expect(filename).toBe('点呼の届出_遠隔点呼_2026-11-10.zip')
    const files = unzipSync(bytes)
    expect(Object.keys(files).sort()).toEqual([BROCHURE_FILENAME, 'egov-tenko-todokede-sankou_remote_2026-11-03_記入済み.xlsx'].sort())
    expect(BROCHURE_FILENAME.startsWith('67_')).toBe(true)
    expect(strFromU8(files[BROCHURE_FILENAME]!)).toBe('%PDF-架空')
    expect(vi.mocked(f).mock.calls.find(c => c[0] === BROCHURE_URL)![1]).toEqual({ cache: 'no-store' })
  })

  it('自動点呼にはパンフレットを入れない', async () => {
    const f = fetcher()
    const { bytes, filename } = await buildFilingZip([egov], settings(), AUTO, f)
    expect(filename).toBe('点呼の届出_自動点呼_2026-11-10.zip')
    expect(Object.keys(unzipSync(bytes))).toEqual(['egov-tenko-todokede-sankou_auto_2026-11-03_記入済み.xlsx'])
    expect(vi.mocked(f).mock.calls.some(c => c[0] === BROCHURE_URL)).toBe(false)
  })

  it('パンフレットが取れないときは例外', async () => {
    await expect(buildFilingZip([egov], settings(), REMOTE, fetcher(new Response('', { status: 404 }))))
      .rejects.toThrow('パンフレットを取得できませんでした (404)')
  })
})

describe('saveBytes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('object URL の a を押して保存させ、後で URL を解く', () => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    saveBytes(new Uint8Array([1]), 'a.docx', 'docx')
    expect((create.mock.calls[0]![0] as Blob).type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const a = click.mock.contexts[0] as HTMLAnchorElement
    expect([a.download, a.href]).toEqual(['a.docx', 'blob:x'])
    expect(document.querySelector('a[download]')).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(revoke).toHaveBeenCalledWith('blob:x')
  })
})
