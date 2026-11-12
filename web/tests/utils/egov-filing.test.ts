// e-Gov の点呼の届出の申請データ (zip) の読み取りと照合。値は架空。
import { describe, it, expect } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { bureauStem, checkEgovFiling, egovDate, parseEgovZip, type EgovFiling } from '~/utils/egov-filing'
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
