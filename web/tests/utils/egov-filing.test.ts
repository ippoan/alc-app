// e-Gov の点呼の届出の申請データ (zip) の読み取りと照合。値は架空。
import { describe, it, expect } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { ARRIVE_FILE, bureauStem, checkEgovFiling, egovDate, fillSettingsFromFiling, norm, parseEgovZip, type EgovEntrust, type EgovFiling, type EgovPerson } from '~/utils/egov-filing'
import { emptySettings, type FilingSettings } from '~/utils/tenko-forms'

interface Office { role?: string, other?: string, name?: string, address?: string, device?: string }

function filingXml(o: { kind?: string, type?: string, start?: string, offices?: Office[], pamphlet?: string, permit?: string, comply?: string } = {}) {
  const slot = (x: Office | undefined, i: number) => `<申請${i + 1}件目>`
    + (x?.role ? `<点呼の実施被実施の別>${x.role}</点呼の実施被実施の別>` : '<点呼の実施被実施の別/>')
    + (x?.other ? `<他事業者名>${x.other}</他事業者名>` : '<他事業者名/>')
    + (x?.name ? `<営業所又は車庫の名称>${x.name}</営業所又は車庫の名称>` : '<営業所又は車庫の名称/>')
    + (x?.address ? `<営業所又は車庫の位置>${x.address}</営業所又は車庫の位置>` : '<営業所又は車庫の位置/>')
    + (x?.device ? `<使用する機器の名称>${x.device}</使用する機器の名称>` : '<使用する機器の名称/>')
    + `</申請${i + 1}件目>`
  const offices = o.offices ?? []
  return `<?xml version="1.0" encoding="UTF-8"?><DataRoot><届出報告情報><届出報告種別>${o.kind ?? '実施'}</届出報告種別><届出報告内容>`
    + `<事業種別>一般貨物</事業種別><点呼の種別>${o.type ?? '遠隔点呼'}</点呼の種別><西暦>${o.start ?? '2030/2/1'}</西暦>`
    + `<点呼に係る営業所又は車庫情報>${[0, 1, 2, 3, 4].map(i => slot(offices[i], i)).join('')}</点呼に係る営業所又は車庫情報>`
    + '<自動点呼の場合><対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します>1</対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します></自動点呼の場合>'
    + '<遠隔点呼又は事業者間遠隔点呼の場合>'
    + `<点呼機器システムのパンフレット等性能及び機能が確認できる書類>${o.pamphlet ?? '1'}</点呼機器システムのパンフレット等性能及び機能が確認できる書類>`
    + `<事業者間遠隔点呼における管理の受委託に係る許可書>${o.permit ?? ''}</事業者間遠隔点呼における管理の受委託に係る許可書>`
    + `<対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します>${o.comply ?? '1'}</対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します>`
    + '</遠隔点呼又は事業者間遠隔点呼の場合></届出報告内容></届出報告情報></DataRoot>'
}

const kouseiXml = (dests: string[], files: string[]) => '<?xml version="1.0" encoding="UTF-8"?><DataRoot>'
  + dests.map(d => `<提出先名称>${d}</提出先名称>`).join('')
  + files.map(f => `<添付書類ファイル名称>${f}</添付書類ファイル名称>`).join('')
  + '</DataRoot>'

const DIR = '15596A0695000001/15596A0695000001/'

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}

const OFFICES: Office[] = [
  { role: '実施', name: '甲営業所', address: '長崎県架空市1-1', device: '一歩庵点呼 v1' },
  { role: '被実施', name: '乙営業所', address: '福岡県架空町2-2', device: '一歩庵点呼 v1' },
]

function settings(over: Partial<FilingSettings> = {}): FilingSettings {
  return {
    ...emptySettings(),
    device_name: '一歩庵点呼 v1',
    offices: [
      { name: '甲営業所', address: '長崎県架空市1-1', role: 1 },
      { name: '乙営業所', address: '福岡県架空町2-2', role: 2 },
    ],
    ...over,
  }
}

function filing(over: Partial<EgovFiling> = {}): EgovFiling {
  return {
    procId: '15596A0695000001',
    procName: '架空の届出',
    procedure: 'filing',
    applicant: null,
    contact: null,
    corporateNumber: '',
    entrust: null,
    applyDate: '2030-01-01',
    reportKind: '実施',
    businessType: '一般貨物',
    tenkoType: '遠隔点呼',
    startDate: '2030-02-01',
    offices: OFFICES.map(o => ({ role: o.role!, otherCompany: '', name: o.name!, address: o.address!, deviceName: o.device! })),
    destinations: ['長崎運輸支局'],
    attachments: ['67_点呼機器.pdf'],
    pamphletChecked: true,
    permitChecked: false,
    complyChecked: true,
    ...over,
  }
}

const messages = (f: EgovFiling, s = settings()) => checkEgovFiling(f, s, '2030-01-01').map(x => `${x.level}:${x.message}`)

describe('egovDate', () => {
  it('e-Gov の書き方を YYYY-MM-DD にし、読めなければ空', () => {
    expect([egovDate('2030/2/1'), egovDate(' 2030/12/01 '), egovDate('2030-02-01'), egovDate('')]).toEqual(['2030-02-01', '2030-12-01', '', ''])
  })
})

describe('parseEgovZip', () => {
  it('到達の zip から申請日・種別・開始日・営業所・提出先・添付を読む (空の申請欄は捨てる)', () => {
    const f = parseEgovZip(zipOf({
      [`${DIR}15596A069500010000_01.xml`]: '<DataRoot><西暦>2030/1/1</西暦></DataRoot>',
      [`${DIR}15596A069500020000_01.xml`]: filingXml({ offices: [{ ...OFFICES[0], other: '架空運輸' }, OFFICES[1]!], permit: '1' }),
      [`${DIR}kousei.xml`]: kouseiXml(['国土交通省,九州運輸局,長崎運輸支局'], ['67_点呼機器.pdf']),
    }))
    expect(f).toEqual({
      procId: '',
      procName: '',
      procedure: 'filing',
      applicant: null,
      contact: null,
      corporateNumber: '',
      entrust: null,
      applyDate: '2030-01-01',
      reportKind: '実施',
      businessType: '一般貨物',
      tenkoType: '遠隔点呼',
      startDate: '2030-02-01',
      offices: [
        { role: '実施', otherCompany: '架空運輸', name: '甲営業所', address: '長崎県架空市1-1', deviceName: '一歩庵点呼 v1' },
        { role: '被実施', otherCompany: '', name: '乙営業所', address: '福岡県架空町2-2', deviceName: '一歩庵点呼 v1' },
      ],
      destinations: ['長崎運輸支局'],
      attachments: ['67_点呼機器.pdf'],
      pamphletChecked: true,
      permitChecked: true,
      complyChecked: true,
    })
  })

  it('申請基礎情報と構成情報が無い (一時保存など) ときは空で読む。届出・報告情報が無ければ例外', () => {
    const f = parseEgovZip(zipOf({ '15596A069500020000_01.xml': filingXml({ pamphlet: '', comply: '' }) }))
    expect([f.applyDate, f.destinations, f.attachments, f.offices, f.pamphletChecked, f.complyChecked]).toEqual(['', [], [], [], false, false])
    const bare = parseEgovZip(zipOf({ '15596A069500020000_01.xml': '<DataRoot/>' }))
    expect([bare.reportKind, bare.tenkoType, bare.offices, bare.complyChecked]).toEqual(['', '', [], false])
    expect(() => parseEgovZip(zipOf({ 'other.xml': '<a/>' }))).toThrow('申請データが見つかりません')
  })
})

describe('bureauStem', () => {
  it('都道府県から支局の名前の語を出す。兵庫は神戸、北海道と読めない所在地は null', () => {
    expect(['長崎県大村市', '大阪府堺市', '東京都港区', '神奈川県横浜市', '兵庫県神戸市', '北海道釧路市', '架空'].map(bureauStem))
      .toEqual(['長崎', '大阪', '東京', '神奈川', '神戸', null, null])
  })
})

describe('checkEgovFiling', () => {
  it('食い違いが無ければ空', () => {
    expect(messages(filing())).toEqual([])
  })

  it('機器の名称が保存した値と 1 文字でも違えば止める (2026-11-12 の「一歩庵点呼　v01」)。保存が空なら見ない', () => {
    const f = filing({ offices: [{ ...filing().offices[0]!, deviceName: '一歩庵点呼　v01' }] })
    expect(messages(f)).toEqual(['error:申請 1 件目 (甲営業所): 使用する機器の名称が「一歩庵点呼　v01」です。届出の画面の「一歩庵点呼 v1」をコピーして貼ってください'])
    expect(messages(f, settings({ device_name: null }))).toEqual([])
  })

  it('営業所の前後の空白・保存に無い営業所・所在地と実施の別の違いを知らせる (空白の違いは同じとみなす)', () => {
    const base = filing().offices
    const f = filing({
      offices: [
        { ...base[0]!, name: '甲営業所 ', address: '長崎県架空市 1-1' },
        { ...base[1]!, address: '福岡県架空町9-9', role: '実施' },
        { ...base[1]!, name: '', address: '福岡県架空町3-3' },
      ],
    })
    expect(messages(f, settings({ offices: [...settings().offices, { name: '丙', address: null, role: 9 }] }))).toEqual([
      'warn:申請 1 件目 (甲営業所): 名称か所在地の前後に空白があります',
      'warn:申請 2 件目 (乙営業所): 所在地が保存した「福岡県架空町2-2」と違います',
      'warn:申請 2 件目 (乙営業所): 実施・被実施の別が保存した「被実施」と違います',
      'warn:申請 3 件目 (名称なし): 届出の画面に保存した営業所にありません',
    ])
    const odd = filing({ offices: [{ ...base[0]!, name: '丙', address: '' }] })
    expect(messages(odd, settings({ offices: [{ name: '丙', address: null, role: 9 }] }))).toEqual([
      'warn:申請 1 件目 (丙): 実施・被実施の別が保存した「」と違います',
    ])
    const noAddr = filing({ offices: [{ ...base[0]!, name: '丙' }] })
    expect(messages(noAddr, settings({ offices: [{ name: '丙', address: null, role: 1 }] }))).toEqual([
      'warn:申請 1 件目 (丙): 所在地が保存した「」と違います',
    ])
  })

  it('営業所が 1 件も無ければ止める', () => {
    expect(messages(filing({ offices: [], destinations: [] }))).toEqual(['error:点呼に係る営業所・車庫が 1 件も入っていません'])
  })

  it('実施の届出は開始日が要り、申請日 (無ければ今日) の 10 日後より前は止める。変更・終了は見ない', () => {
    expect(messages(filing({ startDate: '' }))).toEqual(['error:開始日が入っていません'])
    expect(messages(filing({ startDate: '2030-01-10' }))).toEqual(['error:開始日 2030-01-10 は申請日の 10 日後 (2030-01-11) より前です'])
    expect(messages(filing({ applyDate: '', startDate: '2030-01-11' }))).toEqual([])
    expect(messages(filing({ reportKind: '変更', startDate: '', attachments: [], pamphletChecked: false }))).toEqual([])
  })

  it('遠隔点呼の実施はパンフレット (#67) のチェックとファイル、宣誓 (#69) が要る。終了は宣誓も見ない', () => {
    expect(messages(filing({ pamphletChecked: false, attachments: ['代理.pdf'], complyChecked: false }))).toEqual([
      'error:#67 点呼機器のパンフレットの「添付しました」にチェックがありません',
      'error:#67 点呼機器のパンフレットのファイル (名前の先頭が 67_) が添付されていません',
      'error:#69 告示の要件を遵守する宣誓にチェックがありません',
    ])
    expect(messages(filing({ reportKind: '終了', complyChecked: false, attachments: [] }))).toEqual([])
    expect(messages(filing({ tenkoType: '自動点呼', complyChecked: false, attachments: [], pamphletChecked: false }))).toEqual([])
  })

  it('事業者間遠隔点呼は許可書 (#68) と他事業者名 (#18) が要る。終了のときは見ない', () => {
    const inter = filing({ tenkoType: '事業者間遠隔点呼' })
    expect(messages(inter)).toEqual([
      'error:#68 管理の受委託の許可書 (名前の先頭が 68_) が添付されていません',
      'error:事業者間遠隔点呼なのに、#18 他事業者名がどの営業所にも入っていません',
    ])
    expect(messages({ ...inter, permitChecked: true })).toHaveLength(2)
    const ok = filing({
      tenkoType: '事業者間遠隔点呼',
      permitChecked: true,
      attachments: ['67_a.pdf', '68_許可書.pdf'],
      offices: filing().offices.map((o, i) => ({ ...o, otherCompany: i ? '架空運輸' : ' ' })),
    })
    expect(messages(ok)).toEqual([])
    expect(messages({ ...inter, reportKind: '終了', complyChecked: false })).toEqual([])
  })

  it('提出先がどの営業所の所在地の支局とも合わなければ知らせる。北海道の営業所があれば見ない', () => {
    expect(messages(filing({ destinations: ['福岡運輸支局', '大阪運輸支局'] }))).toEqual([
      'warn:提出先の「大阪運輸支局」は、どの営業所の所在地の支局とも合いません',
    ])
    const hokkaido = filing().offices.map((o, i) => (i ? { ...o, address: '北海道架空市1' } : o))
    expect(messages(filing({ offices: hokkaido, destinations: ['大阪運輸支局'] }), settings({ offices: [] }))).toEqual([
      'warn:申請 1 件目 (甲営業所): 届出の画面に保存した営業所にありません',
      'warn:申請 2 件目 (乙営業所): 届出の画面に保存した営業所にありません',
    ])
  })
})

// ---- 構成情報 (申請者情報・連絡先情報) と受委託の許可申請。値は架空

const personXml = (tag: string, p: Partial<Record<string, string>>) => `<${tag}>`
  + ['氏名', '氏名フリガナ', '役職', '法人団体名', '法人団体名フリガナ', '部門名', '郵便番号', '住所', '住所フリガナ', '電話番号', '電子メールアドレス']
    .map(k => p[k] ? `<${k}>${p[k]}</${k}>` : `<${k} />`).join('')
  + `</${tag}>`

const APPLICANT = { 氏名: '架空　太郎', 氏名フリガナ: 'カクウ　タロウ', 役職: '代表取締役', 法人団体名: '架空運輸株式会社', 法人団体名フリガナ: 'カクウウンユ', 郵便番号: '0000001', 住所: '長崎県架空市１番地１', 住所フリガナ: 'ナガサキケン', 電話番号: '000-0000-0001' }
const CONTACT = { 氏名: '架空　花子', 氏名フリガナ: 'カクウ　ハナコ', 法人団体名: '架空運輸株式会社', 部門名: '架空課', 郵便番号: '0000001', 住所: '長崎県架空市1-1', 電話番号: '000-0000-0002', 電子メールアドレス: 'contact@example.com' }

const entrustKousei = (procId = '15596A0478000001') => '<?xml version="1.0" encoding="utf-8"?><DataRoot><構成情報><管理情報>'
  + `<手続番号><手続ID>${procId}</手続ID></手続番号><手続名称>架空の受委託の許可</手続名称>`
  + `<申請者連絡先情報>${personXml('申請者情報', APPLICANT)}${personXml('連絡先情報', CONTACT)}</申請者連絡先情報>`
  + '</管理情報><提出先情報><提出先名称>国土交通省,九州運輸局,長崎運輸支局</提出先名称></提出先情報>'
  + '<添付書類属性情報><添付書類ファイル名称 /></添付書類属性情報></構成情報><その他><法人番号>0000000000001</法人番号></その他></DataRoot>'

const entrustXml = (o: { start?: string, end?: string, contract?: string, details?: string } = {}) => '<?xml version="1.0" encoding="UTF-8"?><DataRoot><申請内容>'
  + '<委託者><氏名又は名称>架空物流株式会社</氏名又は名称><住所>福岡県架空町2-2</住所><代表者氏名>架空　次郎</代表者氏名>'
  + '<委託営業所><名称>本社営業所</名称><所在地>福岡県架空町2-2</所在地></委託営業所></委託者>'
  + '<受託者><氏名又は名称>架空運輸株式会社</氏名又は名称><住所>長崎県架空市1-1</住所><代表者氏名>架空　太郎</代表者氏名>'
  + '<受託営業所><名称>甲営業所</名称><所在地>長崎県架空市1-1</所在地></受託営業所></受託者>'
  + `<開始の予定日及び期間><西暦>${o.start ?? '2030/6/1'}</西暦><西暦>${o.end ?? '2035/5/31'}</西暦></開始の予定日及び期間>`
  + `<管理の委託受託契約書>${o.contract ?? '1'}</管理の委託受託契約書>`
  + `<管理の報酬その他管理の実施方法の細目を記載した書類>${o.details ?? '1'}</管理の報酬その他管理の実施方法の細目を記載した書類>`
  + '</申請内容></DataRoot>'

const EDIR = 'd_x/15596A0478000001/'
const entrustZip = (o: Parameters<typeof entrustXml>[0] = {}) => zipOf({
  [`${EDIR}15596A047800010000_01.xml`]: '<DataRoot><西暦>2030/1/1</西暦></DataRoot>',
  [`${EDIR}15596A047800020000_01.xml`]: entrustXml(o),
  [`${EDIR}kousei.xml`]: entrustKousei(),
})

function egovPerson(over: Partial<EgovPerson> = {}): EgovPerson {
  return { name: '', kana: '', title: '', corporation: '', corporationKana: '', dept: '', postalCode: '', address: '', addressKana: '', phone: '', email: '', ...over }
}

function entrust(over: Partial<EgovEntrust> = {}): EgovEntrust {
  return {
    consignor: { name: '架空物流株式会社', address: '福岡県架空町2-2', representative: '架空　次郎', officeName: '本社営業所', officeAddress: '福岡県架空町2-2' },
    consignee: { name: '架空運輸株式会社', address: '長崎県架空市1-1', representative: '架空　太郎', officeName: '甲営業所', officeAddress: '長崎県架空市1-1' },
    startDate: '2030-06-01',
    endDate: '2035-05-31',
    contractChecked: true,
    detailsChecked: true,
    ...over,
  }
}

const entrustFiling = (over: Partial<EgovFiling> = {}) => filing({
  procId: '15596A0478000001', procedure: 'entrust', entrust: entrust(), offices: [], reportKind: '', tenkoType: '', startDate: '',
  attachments: ['契約書.pdf'], ...over,
})

const self = (over: Partial<FilingSettings> = {}) => settings({
  operator_name: '架空運輸株式会社',
  operator_address: '長崎県架空市1-1',
  operator_representative: '架空　太郎',
  partners: [{ name: '架空物流株式会社', address: '福岡県架空町2-2', representative: '架空　次郎', offices: [{ name: '本社営業所', address: '福岡県架空町2-2' }] }],
  ...over,
})

describe('ARRIVE_FILE と norm', () => {
  it('到達番号の名前の zip だけ拾い、比べる形は全角英数・ハイフン・空白をならす', () => {
    expect(['20991231235959001e.zip', '2099123123595902.zip', 'input.zip', '209912312359590.zip', '2099123123595900E.zip'].map(n => ARRIVE_FILE.exec(n)?.[1] ?? null))
      .toEqual(['20991231235959001e', '2099123123595902', null, null, null])
    expect([norm('長崎県 架空市１－１'), norm(null), norm('ｶｸｳ')]).toEqual(['長崎県架空市1-1', '', 'カクウ'])
  })
})

describe('parseEgovZip (構成情報・受委託)', () => {
  it('受委託の許可申請の一時保存から、申請者情報・連絡先情報・法人番号・委託者・受託者・期間・添付のチェックを読む', () => {
    const f = parseEgovZip(entrustZip())
    expect([f.procId, f.procName, f.procedure, f.corporateNumber, f.applyDate, f.destinations, f.attachments, f.offices])
      .toEqual(['15596A0478000001', '架空の受委託の許可', 'entrust', '0000000000001', '2030-01-01', ['長崎運輸支局'], [], []])
    expect(f.applicant).toEqual(egovPerson({ name: '架空　太郎', kana: 'カクウ　タロウ', title: '代表取締役', corporation: '架空運輸株式会社', corporationKana: 'カクウウンユ', postalCode: '0000001', address: '長崎県架空市１番地１', addressKana: 'ナガサキケン', phone: '000-0000-0001' }))
    expect(f.contact).toEqual(egovPerson({ name: '架空　花子', kana: 'カクウ　ハナコ', corporation: '架空運輸株式会社', dept: '架空課', postalCode: '0000001', address: '長崎県架空市1-1', phone: '000-0000-0002', email: 'contact@example.com' }))
    expect(f.entrust).toEqual(entrust())
    const off = parseEgovZip(entrustZip({ contract: '', details: '', end: '' }))
    expect([off.entrust!.contractChecked, off.entrust!.detailsChecked, off.entrust!.endDate]).toEqual([false, false, ''])
  })

  it('構成情報だけ (ほかの手続) でも読み、委託者・受託者の欄が無い受委託は空で読む', () => {
    const other = parseEgovZip(zipOf({ 'k/kousei.xml': entrustKousei('999999999999999') }))
    expect([other.procedure, other.procId, other.entrust, other.applicant!.corporation]).toEqual(['other', '999999999999999', null, '架空運輸株式会社'])
    const bare = parseEgovZip(zipOf({ '15596A047800020000_01.xml': '<DataRoot><申請内容 /></DataRoot>' }))
    expect([bare.procedure, bare.applicant, bare.applyDate, bare.entrust]).toEqual(['entrust', null, '', {
      consignor: { name: '', address: '', representative: '', officeName: '', officeAddress: '' },
      consignee: { name: '', address: '', representative: '', officeName: '', officeAddress: '' },
      startDate: '', endDate: '', contractChecked: false, detailsChecked: false,
    }])
  })
})

describe('checkEgovFiling (申請者情報・連絡先情報)', () => {
  const people = { applicant: egovPerson({ corporation: '架空運輸株式会社', corporationKana: 'カクウウンユ', name: '架空 太郎', kana: 'カクウ タロウ', title: '代表取締役', postalCode: '000-0001', address: '長崎県架空市１－１', addressKana: 'ナガサキ', phone: '00000000001' }), contact: egovPerson({ name: '架空 花子', kana: 'カクウ ハナコ', dept: '架空課', postalCode: '0000001', address: '長崎県架空市1-1', phone: '000-0000-0002', email: 'contact@example.com' }), corporateNumber: '0000000000001' }

  it('保存した値と合えば何も言わない (全角・空白・ハイフンはならす)。保存が空の欄は比べない', () => {
    const s = settings({
      operator_name: '架空運輸株式会社', operator_kana: 'カクウウンユ', operator_representative: '架空　太郎', operator_representative_kana: 'カクウ　タロウ',
      operator_representative_title: '代表取締役', operator_postal_code: '0000001', operator_address: '長崎県架空市1-1', operator_address_kana: 'ナガサキ',
      operator_phone: '000-0000-0001', operator_contact_name: '架空　花子', operator_contact_kana: 'カクウ　ハナコ', operator_contact_dept: '架空課',
      operator_contact_phone: '000-0000-0002', operator_contact_email: 'contact@example.com', operator_corporate_number: '0000000000001',
    })
    expect(messages(filing(people), s)).toEqual([])
    expect(messages(filing(people))).toEqual([])
  })

  it('食い違う欄ごとに知らせる。連絡先の郵便番号・住所は担当者の値が無ければ事業者の値と比べる', () => {
    const s = settings({
      operator_name: '別の運輸', operator_kana: 'ベツ', operator_representative: '別の人', operator_representative_kana: 'ベツ', operator_representative_title: '取締役',
      operator_postal_code: '9999999', operator_address: '別の住所', operator_address_kana: 'ベツ', operator_phone: '1', operator_contact_name: '別', operator_contact_kana: 'ベツ',
      operator_contact_dept: '別課', operator_contact_phone: '2', operator_contact_email: 'other@example.com', operator_corporate_number: '9999999999999',
    })
    expect(messages(filing(people), s)).toEqual([
      'warn:申請者情報の「法人団体名」が「架空運輸株式会社」です。保存した値は「別の運輸」',
      'warn:申請者情報の「法人団体名フリガナ」が「カクウウンユ」です。保存した値は「ベツ」',
      'warn:申請者情報の「氏名 (代表者)」が「架空 太郎」です。保存した値は「別の人」',
      'warn:申請者情報の「氏名フリガナ」が「カクウ タロウ」です。保存した値は「ベツ」',
      'warn:申請者情報の「役職」が「代表取締役」です。保存した値は「取締役」',
      'warn:申請者情報の「郵便番号」が「000-0001」です。保存した値は「9999999」',
      'warn:申請者情報の「住所」が「長崎県架空市１－１」です。保存した値は「別の住所」',
      'warn:申請者情報の「住所フリガナ」が「ナガサキ」です。保存した値は「ベツ」',
      'warn:申請者情報の「電話番号」が「00000000001」です。保存した値は「1」',
      'warn:連絡先情報の「氏名」が「架空 花子」です。保存した値は「別」',
      'warn:連絡先情報の「氏名フリガナ」が「カクウ ハナコ」です。保存した値は「ベツ」',
      'warn:連絡先情報の「部門名」が「架空課」です。保存した値は「別課」',
      'warn:連絡先情報の「郵便番号」が「0000001」です。保存した値は「9999999」',
      'warn:連絡先情報の「住所」が「長崎県架空市1-1」です。保存した値は「別の住所」',
      'warn:連絡先情報の「電話番号」が「000-0000-0002」です。保存した値は「2」',
      'warn:連絡先情報の「電子メールアドレス」が「contact@example.com」です。保存した値は「other@example.com」',
      'warn:構成情報の「法人番号」が「0000000000001」です。保存した値は「9999999999999」',
    ])
    const own = settings({ operator_postal_code: '9999999', operator_address: '別', operator_contact_postal_code: '0000001', operator_contact_address: '長崎県架空市1-1' })
    expect(messages(filing({ contact: people.contact }), own)).toEqual([])
    expect(messages(filing({ contact: egovPerson() }), settings({ operator_contact_name: '架空' }))).toEqual(['warn:連絡先情報の「氏名」が「(空)」です。保存した値は「架空」'])
  })
})

describe('checkEgovFiling (受委託の許可申請)', () => {
  const msgs = (f: EgovFiling, s: FilingSettings, today = '2030-01-01') => checkEgovFiling(f, s, today).map(x => `${x.level}:${x.message}`)

  it('自社と相手の会社に保存した値と合い、期間・添付がそろえば何も言わない (届出の決まりは見ない)', () => {
    expect(msgs(entrustFiling(), self())).toEqual([])
    // 受託者が相手の会社で委託者が自社でもよい
    const swapped = entrust({ consignor: entrust().consignee, consignee: entrust().consignor })
    expect(msgs(entrustFiling({ entrust: swapped }), self())).toEqual([])
  })

  it('自社・相手の会社の住所・代表者・営業所の食い違い、保存の無い相手を知らせる', () => {
    const e = entrust({
      consignor: { name: '架空物流株式会社', address: '別', representative: '別', officeName: '別営業所', officeAddress: 'x' },
      consignee: { name: '架空運輸株式会社', address: '別', representative: '別', officeName: '甲営業所', officeAddress: '別' },
    })
    expect(msgs(entrustFiling({ entrust: e }), self())).toEqual([
      'warn:委託者 (架空物流株式会社)の「住所」が「別」です。保存した値は「福岡県架空町2-2」',
      'warn:委託者 (架空物流株式会社)の「代表者氏名」が「別」です。保存した値は「架空　次郎」',
      'warn:委託者 (架空物流株式会社): 営業所「別営業所」は相手の会社に保存した営業所にありません',
      'warn:受託者 (架空運輸株式会社)の「住所」が「別」です。保存した値は「長崎県架空市1-1」',
      'warn:受託者 (架空運輸株式会社)の「代表者氏名」が「別」です。保存した値は「架空　太郎」',
      'warn:受託者 (架空運輸株式会社)の「営業所の所在地」が「別」です。保存した値は「長崎県架空市1-1」',
    ])
    const e2 = entrust({
      consignor: { name: '', address: '', representative: '', officeName: '', officeAddress: '' },
      consignee: { ...entrust().consignee, officeName: '丙営業所' },
    })
    expect(msgs(entrustFiling({ entrust: e2 }), self())).toEqual([
      'warn:委託者 (名称なし): 受委託の相手の会社に保存されていません',
      'warn:受託者 (架空運輸株式会社): 営業所「丙営業所」は届出の画面に保存した営業所にありません',
    ])
    const e3 = entrust({ consignee: { ...entrust().consignor, name: '架空倉庫' } })
    expect(msgs(entrustFiling({ entrust: e3 }), self())).toEqual([
      'warn:受託者 (架空倉庫): 受委託の相手の会社に保存されていません',
      'warn:委託者・受託者のどちらも、保存した「届け出る事業者」の名称と合いません',
    ])
    // 自社の名称を保存していなければ自社の照合はしない
    expect(msgs(entrustFiling({ entrust: e3 }), self({ operator_name: null }))).toEqual(['warn:受託者 (架空倉庫): 受委託の相手の会社に保存されていません'])
  })

  it('期間 (2 か月前・5 年)・添付のチェックと添付ファイルを照らす', () => {
    expect(msgs(entrustFiling({ entrust: entrust({ startDate: '' }) }), self())).toEqual(['error:開始の予定日が入っていません'])
    expect(msgs(entrustFiling({ applyDate: '', entrust: entrust({ startDate: '2030-02-01', endDate: '' }) }), self(), '2030-01-01')).toEqual([
      'warn:開始の予定日 2030-02-01 の 2 か月前 (2029-12-01) を過ぎています (通達は開始の 2 か月前までの申請)',
      'error:期間の終わりの日が入っていません',
    ])
    expect(msgs(entrustFiling({ entrust: entrust({ endDate: '2035-06-01', contractChecked: false, detailsChecked: false }), attachments: [] }), self())).toEqual([
      'error:期間が 5 年を超えています (2030-06-01 〜 2035-06-01)',
      'error:「管理の委託受託契約書」の添付にチェックがありません',
      'error:「管理の報酬その他管理の実施方法の細目を記載した書類」の添付にチェックがありません',
      'warn:添付ファイルがまだ付いていません (契約書・細目・自己点検表)',
    ])
    // ちょうど 2 か月前・ちょうど 5 年は通る
    expect(msgs(entrustFiling({ applyDate: '2030-04-01' }), self())).toEqual([])
  })

  it('ほかの手続は構成情報だけ照らす', () => {
    expect(msgs(filing({ procedure: 'other', offices: [], applicant: egovPerson({ corporation: '別' }) }), self({ operator_address: null, operator_representative: null }))).toEqual([
      'warn:申請者情報の「法人団体名」が「別」です。保存した値は「架空運輸株式会社」',
    ])
  })
})

describe('fillSettingsFromFiling', () => {
  it('空の欄だけを申請データの値で埋め、相手の会社と営業所を足す (元は変えない)', () => {
    const f = parseEgovZip(entrustZip())
    const before = settings({ operator_representative: '保存済みの代表者' })
    const next = fillSettingsFromFiling(f, before)
    expect(before.operator_name).toBeNull()
    expect(before.partners).toEqual([])
    expect(next).toMatchObject({
      operator_name: '架空運輸株式会社', operator_kana: 'カクウウンユ', operator_representative: '保存済みの代表者',
      operator_representative_kana: 'カクウ　タロウ', operator_representative_title: '代表取締役', operator_postal_code: '0000001',
      operator_address: '長崎県架空市１番地１', operator_address_kana: 'ナガサキケン', operator_phone: '000-0000-0001',
      operator_contact_name: '架空　花子', operator_contact_kana: 'カクウ　ハナコ', operator_contact_dept: '架空課',
      operator_contact_phone: '000-0000-0002', operator_contact_email: 'contact@example.com',
      operator_contact_postal_code: null, operator_contact_address: '長崎県架空市1-1', operator_corporate_number: '0000000000001',
    })
    expect(next.partners).toEqual([{ name: '架空物流株式会社', address: '福岡県架空町2-2', representative: '架空　次郎', offices: [{ name: '本社営業所', address: '福岡県架空町2-2' }] }])
    // 2 度目は相手の会社も営業所も重ねない。既に在る相手には営業所だけ足す
    expect(fillSettingsFromFiling(f, next).partners).toEqual(next.partners)
    const known = settings({ operator_name: '架空運輸株式会社', partners: [{ name: '架空物流株式会社', address: null, representative: null, offices: [] }] })
    expect(fillSettingsFromFiling(f, known).partners).toEqual([{ name: '架空物流株式会社', address: null, representative: null, offices: [{ name: '本社営業所', address: '福岡県架空町2-2' }] }])
  })

  it('連絡先情報だけなら、事業者の郵便番号・住所と違うときに担当者の欄へ入れる。所在地の無い営業所は null', () => {
    const contact = egovPerson({ postalCode: '111-1111', address: '福岡県架空町3-3' })
    expect(fillSettingsFromFiling(filing({ contact }), settings())).toMatchObject({ operator_contact_postal_code: '1111111', operator_contact_address: '福岡県架空町3-3' })
    const same = settings({ operator_postal_code: '1111111', operator_address: '福岡県架空町3-3' })
    expect(fillSettingsFromFiling(filing({ contact }), same)).toMatchObject({ operator_contact_postal_code: null, operator_contact_address: null })
    const e = entrust({ consignor: { ...entrust().consignor, officeAddress: ' ' } })
    expect(fillSettingsFromFiling(entrustFiling({ entrust: e }), settings()).partners[0]!.offices).toEqual([{ name: '本社営業所', address: null }])
  })

  it('申請者情報・連絡先情報・受委託が無ければ埋めない。名称の無い相手・営業所は足さない', () => {
    const s = settings()
    expect(fillSettingsFromFiling(filing(), s)).toEqual(s)
    const e = entrust({ consignor: { name: ' ', address: '', representative: '', officeName: '', officeAddress: '' }, consignee: { name: '架空倉庫', address: '', representative: '', officeName: ' ', officeAddress: '' } })
    expect(fillSettingsFromFiling(entrustFiling({ applicant: null, contact: null, entrust: e }), s).partners)
      .toEqual([{ name: '架空倉庫', address: null, representative: null, offices: [] }])
  })
})
